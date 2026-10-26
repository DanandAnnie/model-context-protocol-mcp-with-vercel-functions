import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { designVoice, designVoiceSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Designs an account may ask for per hour: each one is paid for with the voice provider. */
const PER_OWNER = 10;
const WINDOW_MS = 60 * 60 * 1000;

/** Design voices from a description: previews to choose from, none kept until one is saved. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = designVoiceSchema.parse(await readJson(req));
    const limit = rateLimit(`voicedesign:${owner}`, PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: `At most ${PER_OWNER} voice designs an hour; try again later` }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json(await designVoice(input, owner));
  } catch (err) {
    return errorResponse(err);
  }
}
