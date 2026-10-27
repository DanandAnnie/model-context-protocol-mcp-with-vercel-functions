import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimitPair } from "@/lib/rate-limit";
import { LimitError, createInstantVoice, instantVoiceSchema, publicInstantVoice, voiceChangerKeySchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Instant voices an account may make per hour, and every account together, per server instance. */
const PER_OWNER = 5;
const PER_INSTANCE = 20;
const WINDOW_MS = 60 * 60 * 1000;

/** Make an instant voice from one of the account's audio clips: `{ name, clipId, agreed: true }`. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = instantVoiceSchema.parse(await readJson(req));
    const header = req.headers.get("idempotency-key");
    const key = header ? voiceChangerKeySchema.parse(header) : undefined;
    // Counted only once the request is checked and new, so a refused or repeated start does not use up the hour's.
    const admit = () => {
      const limit = rateLimitPair(`instantvoice:${owner}`, PER_OWNER, "instantvoice:*", PER_INSTANCE, WINDOW_MS);
      if (!limit.allowed) throw new LimitError(`Too many new voices for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    };
    return json({ voice: publicInstantVoice(await createInstantVoice(input, owner, { key, admit })) }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
