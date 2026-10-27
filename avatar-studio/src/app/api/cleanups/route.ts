import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimit, rateLimitPair } from "@/lib/rate-limit";
import { cleanupAvailable, cleanupRequestSchema, listCleanups, publicCleanup, resolveCleanupSource, startCleanup } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Cleanups an account may start per hour, and every account together: each one is paid for with the renderer.
 * Counted per server instance, as the other limits are.
 */
const PER_OWNER = 10;
const PER_INSTANCE = 40;
/** Listings an account may make per hour: a cleanup is followed every few seconds, and each may ask the renderer. */
const LISTS_PER_OWNER = 300;
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
    // A request that would be refused anyway does not use up the hour's starts.
    await resolveCleanupSource(input, owner);
    const limit = rateLimitPair(`cleanup:${owner}`, PER_OWNER, "cleanup:*", PER_INSTANCE, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many cleanups for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ cleanup: publicCleanup(await startCleanup(input, owner)) }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
