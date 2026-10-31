import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { searchMusicTracks } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Searches an account may make per hour: each one asks the renderer's catalog. */
const PER_OWNER = 120;
const WINDOW_MS = 60 * 60 * 1000;

/**
 * Tracks of the renderer's catalog matching `?query=` (a description in plain words), best first: music, or sound
 * effects with `?type=effects`.
 */
export async function GET(req: Request) {
  try {
    const owner = await requireEditor();
    const limit = rateLimit(`musicsearch:${owner}`, PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many searches for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    const params = new URL(req.url).searchParams;
    return json({ tracks: await searchMusicTracks(params.get("query") ?? "", params.get("type") === "effects" ? "effects" : "music") });
  } catch (err) {
    return errorResponse(err);
  }
}
