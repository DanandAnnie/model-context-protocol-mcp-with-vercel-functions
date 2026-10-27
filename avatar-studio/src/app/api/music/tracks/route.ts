import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { searchMusicTracks } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Searches an account may make per hour: each one asks the renderer's catalog. */
const PER_OWNER = 120;
const WINDOW_MS = 60 * 60 * 1000;

/** Tracks of the renderer's music catalog matching `?query=` (a description in plain words), best first. */
export async function GET(req: Request) {
  try {
    const owner = await requireEditor();
    const limit = rateLimit(`musicsearch:${owner}`, PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many searches for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ tracks: await searchMusicTracks(new URL(req.url).searchParams.get("query") ?? "") });
  } catch (err) {
    return errorResponse(err);
  }
}
