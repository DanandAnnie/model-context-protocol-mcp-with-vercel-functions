import { errorResponse } from "@/lib/api-utils";
import { publicOrigin } from "@/lib/config";
import { toCsv } from "@/lib/csv";
import { ValidationError } from "@/lib/errors";
import { ANALYTICS_COLUMNS, analyticsRows } from "@/lib/insights";
import { requireOwner } from "@/lib/owner";
import { filterVideos, listVideos, openCommentCounts, videoQuerySchema } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * The library's share analytics as a CSV download: one row per video, newest first. Owner only. Takes the library's own
 * query (search, status, folder, batch, review, share link, star, date made, and sort), so the file can hold what the
 * library shows; `limit` is ignored, as the file holds every match.
 */
export async function GET(req: Request) {
  try {
    const owner = await requireOwner();
    // The page size is the library's; the file holds every match, so `limit` is not even read.
    const query = videoQuerySchema.omit({ limit: true }).parse(Object.fromEntries(new URL(req.url).searchParams));
    // A trashed video's share link answers "not found", so it has no share analytics to give.
    if (query.trash) throw new ValidationError("The trash has no share analytics; restore the videos first");
    const videos = filterVideos(await listVideos(owner, false), query, query.comments === "open" ? await openCommentCounts(owner) : undefined);
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
