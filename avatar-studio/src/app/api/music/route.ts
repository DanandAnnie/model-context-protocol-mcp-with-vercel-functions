import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimit, rateLimitPair } from "@/lib/rate-limit";
import { LimitError, listMusicJobs, musicAvailable, musicKeySchema, musicRequestSchema, publicMusicJob, startMusic } from "@/lib/services";

export const dynamic = "force-dynamic";
// The track is looked up again, the video's link renewed, and the render started, one after another.
export const maxDuration = 60;

/**
 * Videos with music an account may start per hour, and every account together: each one is a render paid for with
 * the renderer. Counted per server instance, as the other limits are.
 */
const PER_OWNER = 10;
const PER_INSTANCE = 40;
/** Catalog searches an account may make per hour, shared with the track search: a start looks its track up again. */
const SEARCHES_PER_OWNER = 120;
/** Listings an account may make per hour: the page asks every ten seconds while a mix renders. */
const LISTS_PER_OWNER = 1500;
const WINDOW_MS = 60 * 60 * 1000;

/** The account's videos with music, newest first; any still being mixed is checked on the way. */
export async function GET() {
  try {
    const owner = await requireOwner();
    const limit = rateLimit(`musiclist:${owner}`, LISTS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many checks for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ mixes: (await listMusicJobs(owner)).map(publicMusicJob), available: musicAvailable() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Mix a catalog track under a finished video: `{ videoId, trackId, query, volume?, title? }`. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = musicRequestSchema.parse(await readJson(req));
    // A client key makes a retried start return the same mix instead of paying for another.
    const header = req.headers.get("idempotency-key");
    const key = header ? musicKeySchema.parse(header) : undefined;
    // Counted only once the request is checked and new, so a refused or repeated start does not use up the hour's starts.
    const admit = () => {
      const limit = rateLimitPair(`music:${owner}`, PER_OWNER, "music:*", PER_INSTANCE, WINDOW_MS);
      if (!limit.allowed) throw new LimitError(`Too many videos with music for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    };
    // The renderer's catalog is asked again for the track on every start that gets that far, so those count too.
    const search = () => {
      const limit = rateLimit(`musicsearch:${owner}`, SEARCHES_PER_OWNER, WINDOW_MS);
      if (!limit.allowed) throw new LimitError("Too many searches for now; try again later");
    };
    return json({ mix: publicMusicJob(await startMusic(input, owner, { key, admit, search })) }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
