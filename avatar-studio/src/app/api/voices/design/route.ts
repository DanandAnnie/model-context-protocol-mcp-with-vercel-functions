import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimitPair } from "@/lib/rate-limit";
import { assertVoiceRoom, designVoice, designVoiceSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Designs an account may ask for per hour, and every account together (a backstop against one person spreading requests
 * over many workspaces): each design is paid for with the voice provider. Counted per server instance, as the other
 * limits are.
 */
const PER_OWNER = 10;
const PER_INSTANCE = 60;
const WINDOW_MS = 60 * 60 * 1000;

/** Design voices from a description: previews to choose from, none kept until one is saved. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = designVoiceSchema.parse(await readJson(req));
    // A full account is told so without using up one of its designs.
    await assertVoiceRoom(owner);
    const limit = rateLimitPair(`voicedesign:${owner}`, PER_OWNER, "voicedesign:*", PER_INSTANCE, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many voice designs for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json(await designVoice(input, owner));
  } catch (err) {
    return errorResponse(err);
  }
}
