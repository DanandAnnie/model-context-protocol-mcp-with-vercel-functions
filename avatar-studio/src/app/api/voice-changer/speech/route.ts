import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimitPair } from "@/lib/rate-limit";
import { LimitError, publicVoiceChange, startVoiceSpeech, voiceChangerKeySchema, voiceSpeechSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
// The renderer answers in seconds for most texts; the start waits for most of a minute, then gives up (502).
export const maxDuration = 60;

/** Texts an account may have spoken per hour, and every account together, per server instance. */
const PER_OWNER = 30;
const PER_INSTANCE = 90;
const WINDOW_MS = 60 * 60 * 1000;

/** Speak text in one of the account's instant voices or one of HeyGen's public voices: `{ voiceId, text, title?, turbo?, expressivenessBoost? }`. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = voiceSpeechSchema.parse(await readJson(req));
    const header = req.headers.get("idempotency-key");
    const key = header ? voiceChangerKeySchema.parse(header) : undefined;
    const admit = () => {
      const limit = rateLimitPair(`voicespeech:${owner}`, PER_OWNER, "voicespeech:*", PER_INSTANCE, WINDOW_MS);
      if (!limit.allowed) throw new LimitError(`Too many texts spoken for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    };
    const change = await startVoiceSpeech(input, owner, { key, admit });
    return json({ change: publicVoiceChange(change) }, { status: change.status === "completed" ? 201 : 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
