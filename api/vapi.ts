import type { VercelRequest, VercelResponse } from "@vercel/node";
import { TOOL_REGISTRY } from "../lib/tools";

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(200).json({ error: "Only POST is accepted" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  const message = req.body?.message;
  if (!message) {
    return res.status(200).json({ error: "No message in request body" });
  }

  const type: string = message.type;

  if (type === "tool-calls") {
    const toolCallList: ToolCall[] = message.toolCallList ?? [];
    const results = await Promise.all(
      toolCallList.map(async (toolCall) => {
        const fn = TOOL_REGISTRY[toolCall.name];
        if (!fn) {
          return {
            toolCallId: toolCall.id,
            result: `Unknown tool: ${toolCall.name}`,
          };
        }
        try {
          const result = await fn(toolCall.arguments);
          return { toolCallId: toolCall.id, result };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return { toolCallId: toolCall.id, result: `Error: ${errMsg}` };
        }
      }),
    );
    return res.status(200).json({ results });
  }

  if (type === "function-call") {
    const { name, parameters } = message.functionCall ?? {};
    const fn = name ? TOOL_REGISTRY[name] : undefined;
    if (!fn) {
      return res.status(200).json({ result: `Unknown function: ${name}` });
    }
    try {
      const result = await fn(parameters ?? {});
      return res.status(200).json({ result });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return res.status(200).json({ result: `Error: ${errMsg}` });
    }
  }

  // For other message types (status-update, end-of-call-report, hang, etc.)
  // return 200 to acknowledge
  return res.status(200).json({});
}
