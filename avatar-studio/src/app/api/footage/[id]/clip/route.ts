import { errorResponse } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { footageLink } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * A generated clip of the account, by its fixed address: a redirect to the renderer's link, renewed when old. The
 * editor previews a scene's clip background through it, and renders name it the same way (they look the link up
 * themselves). Not cached, as the link it sends to expires.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { videoUrl } = await footageLink(id, await requireOwner());
    return new Response(null, { status: 302, headers: { Location: videoUrl, "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
