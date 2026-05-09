// Hermes chat — streaming agent endpoint.
//
// POST /api/hermes-chat
//   body: { messages: [{role, content}, ...], model?, system? }
//   response: text/event-stream
//
// Hermes is a Claude agent wired to this server's MCP tool registry.
// It loops: call Claude → if stop_reason=tool_use, run each tool via
// runTool() in-process and feed results back → repeat until end_turn.
// SSE events: "text" (assistant prose), "tool_use" (tool starting),
// "tool_result" (tool finished, preview included), "done", "error".
//
// Auth follows the rest of Mission Control: requires a valid mc_auth
// cookie or Authorization: Bearer header when MISSION_CONTROL_TOKEN is set.

import { getAuthState } from "./services/auth.js";
import { getToolList, runTool } from "./server.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-7";
const MAX_TOOL_ITERATIONS = 8;
const MAX_TOOL_RESULT_CHARS = 12000;

const HERMES_SYSTEM_PROMPT = `You are Hermes, the command-center agent for The Finest Homes / Red Rock Real Estate.

You have access to a property intelligence MCP toolkit:
- PropertyRadar data (lookups, owner search, mortgage, foreclosure, comps, valuation, investment analysis)
- Public real-estate data (geocoding, flood zones, schools, census, FMR)
- GoHighLevel CRM (contacts, opportunities, calendars, invoices, workflows) for the Red Rock sub-account

Be concise and action-oriented. Surface what matters. When uncertain about a tool's inputs, ask the user rather than guess. Prefer chaining tools to give one synthesized answer over dumping raw results.`;

async function handler(req: Request): Promise<Response> {
  const auth = getAuthState(req);
  if (auth.required && !auth.authenticated) {
    return jsonError(401, "authentication required");
  }
  if (req.method !== "POST") {
    return jsonError(405, `method ${req.method} not allowed`);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return jsonError(503, "ANTHROPIC_API_KEY is not configured");
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid JSON body");
  }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return jsonError(400, "messages array required");
  }

  const model = typeof body?.model === "string" ? body.model : DEFAULT_MODEL;
  const system = typeof body?.system === "string" ? body.system : HERMES_SYSTEM_PROMPT;
  const tools = getToolList().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const conversation: any[] = messages.map(sanitizeMessage);

      try {
        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
          const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": process.env.ANTHROPIC_API_KEY!,
              "anthropic-version": ANTHROPIC_VERSION,
            },
            body: JSON.stringify({
              model,
              max_tokens: 4096,
              system,
              tools,
              messages: conversation,
            }),
          });

          if (!apiRes.ok) {
            const txt = await apiRes.text();
            send("error", { error: `Anthropic ${apiRes.status}: ${txt.slice(0, 500)}` });
            break;
          }

          const reply: any = await apiRes.json();
          const assistantContent = Array.isArray(reply?.content) ? reply.content : [];

          for (const block of assistantContent) {
            if (block?.type === "text" && typeof block.text === "string") {
              send("text", { text: block.text });
            } else if (block?.type === "tool_use") {
              send("tool_use", { id: block.id, name: block.name, input: block.input });
            }
          }

          if (reply?.stop_reason !== "tool_use") {
            send("done", { stop_reason: reply?.stop_reason ?? "end_turn", usage: reply?.usage });
            break;
          }

          conversation.push({ role: "assistant", content: assistantContent });
          const toolResults: any[] = [];
          for (const block of assistantContent) {
            if (block?.type !== "tool_use") continue;
            try {
              const r = await runTool(block.name, block.input);
              const text = (r.content || [])
                .filter((c: any) => c?.type === "text")
                .map((c: any) => c.text)
                .join("\n\n");
              const trimmed = text.length > MAX_TOOL_RESULT_CHARS
                ? text.slice(0, MAX_TOOL_RESULT_CHARS) + "\n\n…(truncated)"
                : text;
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: trimmed || "(empty result)",
              });
              send("tool_result", { id: block.id, name: block.name, ok: true, preview: trimmed.slice(0, 600) });
            } catch (e: any) {
              const errMsg = e?.message ?? String(e);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                is_error: true,
                content: errMsg,
              });
              send("tool_result", { id: block.id, name: block.name, ok: false, error: errMsg });
            }
          }
          conversation.push({ role: "user", content: toolResults });
        }
      } catch (e: any) {
        send("error", { error: e?.message ?? String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function sanitizeMessage(m: any) {
  if (!m || typeof m !== "object") return { role: "user", content: "" };
  const role = m.role === "assistant" ? "assistant" : "user";
  if (typeof m.content === "string") return { role, content: m.content };
  if (Array.isArray(m.content)) return { role, content: m.content };
  return { role, content: String(m.content ?? "") };
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export { handler as POST };
