import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimitPair } from "@/lib/rate-limit";
import { LimitError, publicVoiceChange, startVoiceChange, voiceChangeSchema, voiceChangerKeySchema } from "@/lib/services";

export const dynamic = "force-dynamic";
// The renderer answers within a couple of minutes; the start waits for most of a minute before handing over.
export const maxDuration = 60;

/** Recordings an account may have spoken again per hour, and every account together, per server instance. */
const PER_OWNER = 20;
const PER_INSTANCE = 60;
const WINDOW_MS = 60 * 60 * 1000;

/** Speak one of the account's audio clips again in one of its instant voices: `{ voiceId, clipId, removeNoise?, title? }`. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = voiceChangeSchema.parse(await readJson(req));
    const header = req.headers.get("idempotency-key");
    const key = header ? voiceChangerKeySchema.parse(header) : undefined;
    const admit = () => {
      const limit = rateLimitPair(`voicechange:${owner}`, PER_OWNER, "voicechange:*", PER_INSTANCE, WINDOW_MS);
      if (!limit.allowed) throw new LimitError(`Too many recordings for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    };
    const change = await startVoiceChange(input, owner, { key, admit });
    return json({ change: publicVoiceChange(change) }, { status: change.status === "completed" ? 201 : 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
