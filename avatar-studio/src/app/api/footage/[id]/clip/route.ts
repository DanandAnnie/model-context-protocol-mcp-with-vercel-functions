import { errorResponse } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { footageLink } from "@/lib/services";

/** Clip lookups an account may make per hour: the editor's stage asks once per scene shown, and renders do not come here. */
const LOOKUPS_PER_OWNER = 1500;
const WINDOW_MS = 60 * 60 * 1000;

export const dynamic = "force-dynamic";

/**
 * A generated clip of the account, by its fixed address: a redirect to the renderer's link, renewed when old. The
 * editor previews a scene's clip background through it, and renders name it the same way (they look the link up
 * themselves). Not cached, as the link it sends to expires.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
    const limit = rateLimit(`footageclip:${owner}`, LOOKUPS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return new Response(JSON.stringify({ error: "Too many clip lookups for now; try again later" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(limit.retryAfterSec) } });
    const { videoUrl } = await footageLink(id, owner);
    return new Response(null, { status: 302, headers: { Location: videoUrl, "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
