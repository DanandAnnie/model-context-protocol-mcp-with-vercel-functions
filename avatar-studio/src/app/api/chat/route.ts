import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { chatSchema, chatWithAvatar } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Interactive avatar turn. Rate limited per client because each turn can cost an LLM call. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const gate = rateLimit(`chat:${clientIp(req)}`, 60, 10 * 60 * 1000);
    if (!gate.allowed) return json({ error: "Too many messages; try again in a few minutes" }, { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } });
    const input = chatSchema.parse(await readJson(req));
    return json({ reply: await chatWithAvatar(input, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
