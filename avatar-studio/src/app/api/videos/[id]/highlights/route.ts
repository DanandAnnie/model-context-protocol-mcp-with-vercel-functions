import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimitPair } from "@/lib/rate-limit";
import { highlightRequestSchema, highlightsAvailable, listHighlights, startHighlights } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Clipping jobs an account may start per hour, and every account together: each one is paid for with the renderer.
 * Counted per server instance, as the other limits are.
 */
const PER_OWNER = 10;
const PER_INSTANCE = 40;
const WINDOW_MS = 60 * 60 * 1000;

/** The video's highlight clips, newest set first; sets still being cut are checked on the way. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return json({ highlights: await listHighlights(id, await requireOwner()), available: highlightsAvailable() });
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
    const limit = rateLimitPair(`highlight:${owner}`, PER_OWNER, "highlight:*", PER_INSTANCE, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many clipping jobs for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ highlight: await startHighlights(id, input, owner) }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
