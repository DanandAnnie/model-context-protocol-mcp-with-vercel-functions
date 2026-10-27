import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimit, rateLimitPair } from "@/lib/rate-limit";
import { assertCanStartHighlights, highlightRequestSchema, highlightsAvailable, listHighlights, publicHighlight, startHighlights } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Clipping jobs an account may start per hour, and every account together: each one is paid for with the renderer.
 * Counted per server instance, as the other limits are.
 */
const PER_OWNER = 10;
const PER_INSTANCE = 40;
/**
 * Listings an account may make per hour: the card asks every ten seconds while a set is cut (a long video takes a
 * while), and the renderer is asked at most every few seconds per set whatever the listings.
 */
const LISTS_PER_OWNER = 1500;
const WINDOW_MS = 60 * 60 * 1000;

/** The video's highlight clips, newest set first; sets still being cut are checked on the way. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
    const limit = rateLimit(`highlightlist:${owner}`, LISTS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many checks for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ highlights: (await listHighlights(id, owner)).map(publicHighlight), available: highlightsAvailable() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Start cutting the video into short clips (`{ lengths, frame?, captions?, prompt? }`); follow it with GET. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const owner = await requireEditor();
    const input = highlightRequestSchema.parse(await readJson(req));
    // A request that would be refused anyway does not use up the hour's starts.
    await assertCanStartHighlights(id, input, owner);
    const limit = rateLimitPair(`highlight:${owner}`, PER_OWNER, "highlight:*", PER_INSTANCE, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many clipping jobs for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ highlight: publicHighlight(await startHighlights(id, input, owner)) }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
