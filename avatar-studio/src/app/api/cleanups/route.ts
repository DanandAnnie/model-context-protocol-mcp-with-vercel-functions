import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimit, rateLimitPair } from "@/lib/rate-limit";
import { LimitError, cleanupAvailable, cleanupKeySchema, cleanupRequestSchema, listCleanups, publicCleanup, startCleanup } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Cleanups an account may start per hour, and every account together: each one is paid for with the renderer.
 * Counted per server instance, as the other limits are.
 */
const PER_OWNER = 10;
const PER_INSTANCE = 40;
/**
 * Listings an account may make per hour: the page asks every ten seconds while a cleanup runs (a long recording takes a
 * while), and the renderer is asked at most every few seconds per cleanup whatever the listings.
 */
const LISTS_PER_OWNER = 1500;
const WINDOW_MS = 60 * 60 * 1000;

/** The account's cleaned recordings, newest first; any still being cleaned is checked on the way. */
export async function GET() {
  try {
    const owner = await requireOwner();
    const limit = rateLimit(`cleanuplist:${owner}`, LISTS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many checks for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ cleanups: (await listCleanups(owner)).map(publicCleanup), available: cleanupAvailable() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Clean filler words and long silences out of a recording: `{ videoId }` (one of the account's videos) or `{ sourceUrl }`. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = cleanupRequestSchema.parse(await readJson(req));
    // A client key makes a retried start return the same cleanup instead of paying for another.
    const header = req.headers.get("idempotency-key");
    const key = header ? cleanupKeySchema.parse(header) : undefined;
    // Counted only once the request is checked and new, so a refused or repeated start does not use up the hour's starts.
    const admit = () => {
      const limit = rateLimitPair(`cleanup:${owner}`, PER_OWNER, "cleanup:*", PER_INSTANCE, WINDOW_MS);
      if (!limit.allowed) throw new LimitError(`Too many cleanups for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    };
    return json({ cleanup: publicCleanup(await startCleanup(input, owner, { key, admit })) }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
