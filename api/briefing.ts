// Daily briefing — Hermes-generated morning summary.
//
// GET /api/briefing             → cached briefing (regenerates hourly)
// GET /api/briefing?refresh=1   → forces regeneration
//
// Hermes runs through the MCP tool registry and synthesizes a short,
// scannable markdown briefing covering schedule, pipeline movement,
// market intel, and recommended actions. Cached in module memory by
// hour-of-day key — Vercel Fluid Compute keeps the function warm so
// repeat visits return instantly without hitting Anthropic again.

import { getAuthState } from "./services/auth.js";
import { getToolList, runTool } from "./server.js";

const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-opus-4-7";
const MAX_TOOL_ITERATIONS = 6;
const MAX_TOOL_RESULT_CHARS = 8000;

let cache: { generatedAt: string; markdown: string; key: string } | null = null;

const SYSTEM_PROMPT = `You are Hermes, the morning briefing agent for The Finest Homes / Red Rock Real Estate.

Generate a tight, scannable morning briefing. Use markdown. Keep it under 300 words.

Structure:
**Today's Focus** — one sentence on the day's priority.
**Schedule** — appointments and calendar items, if any.
**Pipeline** — opportunities worth attention from the GHL CRM.
**Market Pulse** — anything notable in the property data.
**Recommended Actions** — 2–4 specific next steps.

Use available tools to ground each section in real data. If a section has nothing notable, say so in one line — don't pad. Be direct, no preamble.`;

async function handler(req: Request): Promise<Response> {
  const auth = getAuthState(req);
  if (auth.required && !auth.authenticated) {
    return json(401, { error: "authentication required" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(503, { error: "ANTHROPIC_API_KEY is not configured" });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("refresh") === "1";
  const key = currentHourKey();

  if (!force && cache && cache.key === key) {
    return json(200, { ...cache, cached: true });
  }

  try {
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    const tools = getToolList().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));

    const messages = [
      {
        role: "user" as const,
        content:
          `Generate today's morning briefing for ${today}. ` +
          `Pull what you need from the available tools — start with GHL pipelines and opportunities to find pipeline movement, ` +
          `list_calendars / get_calendar_free_slots for today's schedule, and any pre-foreclosure or recent-sale hits in our markets ` +
          `that are worth noting. If a tool errors or returns empty, skip that section gracefully. Keep it under 300 words.`,
      },
    ];

    const markdown = await runHermesAgent(messages, tools);
    cache = { generatedAt: new Date().toISOString(), markdown, key };
    return json(200, { ...cache, cached: false });
  } catch (e: any) {
    return json(500, { error: e?.message ?? String(e) });
  }
}

async function runHermesAgent(initialMessages: any[], tools: any[]): Promise<string> {
  const conversation: any[] = [...initialMessages];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools,
        messages: conversation,
      }),
    });

    if (!apiRes.ok) {
      const txt = await apiRes.text();
      throw new Error(`Anthropic ${apiRes.status}: ${txt.slice(0, 400)}`);
    }

    const reply: any = await apiRes.json();
    const content = Array.isArray(reply?.content) ? reply.content : [];

    if (reply?.stop_reason !== "tool_use") {
      return content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("\n\n")
        .trim() || "No briefing available.";
    }

    conversation.push({ role: "assistant", content });
    const results: any[] = [];
    for (const block of content) {
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
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: trimmed || "(empty result)",
        });
      } catch (e: any) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: e?.message ?? String(e),
        });
      }
    }
    conversation.push({ role: "user", content: results });
  }

  throw new Error("briefing generation exceeded max tool iterations");
}

function currentHourKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export { handler as GET };
