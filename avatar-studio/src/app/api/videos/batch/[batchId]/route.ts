import { errorResponse } from "@/lib/api-utils";
import { publicOrigin } from "@/lib/config";
import { toCsv } from "@/lib/csv";
import { requireOwner } from "@/lib/owner";
import { BATCH_LINK_COLUMNS, batchLinkRows, batchVideos } from "@/lib/services";

export const dynamic = "force-dynamic";

/** One personalized batch's videos as a CSV for a mail merge: row, recipient, status, and the share link once it can be sent. */
export async function GET(req: Request, ctx: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await ctx.params;
    const videos = await batchVideos(batchId, await requireOwner());
    return new Response(toCsv([...BATCH_LINK_COLUMNS], batchLinkRows(videos, publicOrigin(req))), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="links-${batchId.replace(/[^a-z0-9_-]/gi, "")}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
