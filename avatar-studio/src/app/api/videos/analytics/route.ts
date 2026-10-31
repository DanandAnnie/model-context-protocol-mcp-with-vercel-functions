import { errorResponse } from "@/lib/api-utils";
import { publicOrigin } from "@/lib/config";
import { toCsv } from "@/lib/csv";
import { ANALYTICS_COLUMNS, analyticsRows } from "@/lib/insights";
import { requireOwner } from "@/lib/owner";
import { listVideos } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The library's share analytics as a CSV download: one row per video, newest first. Owner only. */
export async function GET(req: Request) {
  try {
    const owner = await requireOwner();
    const videos = await listVideos(owner, false);
    const origin = publicOrigin(req);
    return new Response(toCsv([...ANALYTICS_COLUMNS], analyticsRows(videos, origin)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="video-analytics-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
