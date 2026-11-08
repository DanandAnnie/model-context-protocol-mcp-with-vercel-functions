import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimitPair } from "@/lib/rate-limit";
import { audioTagDraftSchema, draftAudioTags, LimitError } from "@/lib/services";

export const dynamic = "force-dynamic";
// Claude answers in seconds for a text of up to 2,000 characters; it is given forty, and one retry.
export const maxDuration = 60;

/** Tag drafts an account may ask for per hour, and every account together, per server instance. */
const PER_OWNER = 20;
const PER_INSTANCE = 60;
const WINDOW_MS = 60 * 60 * 1000;

/** `{ text }` → `{ text, added }`: the text with HeyGen Voice audio tags added by Claude, its words unchanged; nothing is spoken. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = audioTagDraftSchema.parse(await readJson(req));
    // Counted once the request is one Claude is asked about.
    const limit = rateLimitPair(`audiotags:${owner}`, PER_OWNER, "audiotags:*", PER_INSTANCE, WINDOW_MS);
    if (!limit.allowed) throw new LimitError(`Too many tag drafts for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    return json(await draftAudioTags(input));
  } catch (err) {
    return errorResponse(err);
  }
}
