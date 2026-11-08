import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimit, rateLimitPair } from "@/lib/rate-limit";
import { LimitError, lipsyncAvailable, lipsyncKeySchema, lipsyncRequestSchema, listLipsyncs, publicLipsync, startLipsync } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Lip syncs an account may start per hour, and every account together: each one is paid for with the renderer.
 * Counted per server instance, as the other limits are.
 */
const PER_OWNER = 10;
const PER_INSTANCE = 40;
/**
 * Listings an account may make per hour: the page asks every ten seconds while a lip sync runs (a long video takes a
 * while), and the renderer is asked at most every few seconds per lip sync whatever the listings.
 */
const LISTS_PER_OWNER = 1500;
const WINDOW_MS = 60 * 60 * 1000;

/** The account's lip-synced videos, newest first; any still being synced is checked on the way. */
export async function GET() {
  try {
    const owner = await requireOwner();
    const limit = rateLimit(`lipsynclist:${owner}`, LISTS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many checks for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ lipsyncs: (await listLipsyncs(owner)).map(publicLipsync), available: lipsyncAvailable() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Put new audio on a video: `{ videoId }` or `{ sourceUrl }` for the footage, `{ clipId }` or `{ audioUrl }` for the audio, and a `mode`. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = lipsyncRequestSchema.parse(await readJson(req));
    // A client key makes a retried start return the same lip sync instead of paying for another.
    const header = req.headers.get("idempotency-key");
    const key = header ? lipsyncKeySchema.parse(header) : undefined;
    // Counted only once the request is checked and new, so a refused or repeated start does not use up the hour's starts.
    const admit = () => {
      const limit = rateLimitPair(`lipsync:${owner}`, PER_OWNER, "lipsync:*", PER_INSTANCE, WINDOW_MS);
      if (!limit.allowed) throw new LimitError(`Too many lip syncs for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    };
    return json({ lipsync: publicLipsync(await startLipsync(input, owner, { key, admit })) }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
