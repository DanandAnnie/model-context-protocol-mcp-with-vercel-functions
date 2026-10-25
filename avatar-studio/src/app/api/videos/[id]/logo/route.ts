import { errorResponse } from "@/lib/api-utils";
import { logoResponse } from "@/lib/brand-logo";
import { LOCAL_OWNER } from "@/lib/owner";
import { PUBLIC_ACCESS, getBrandKit, getVideo } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * The uploaded brand logo shown on a video's share page (header and player watermark). Public on the
 * share page's own terms: a missing, trashed, or offline video answers 404, and so does a kit whose
 * logo is an external URL (the page links that directly). A password does not hide it, since the
 * locked page shows the brand header too.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const video = await getVideo((await ctx.params).id, PUBLIC_ACCESS, false);
    return logoResponse((await getBrandKit(video.ownerId ?? LOCAL_OWNER))?.logoUrl, req);
  } catch (err) {
    return errorResponse(err);
  }
}
