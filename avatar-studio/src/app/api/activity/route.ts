import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { ACTIVITY_CSV_COLUMNS, activityRows } from "@/lib/activity-text";
import { toCsv } from "@/lib/csv";
import { MAX_ACTIVITY, activityQuerySchema, listActivity } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The account's or workspace's recent activity, newest first; `?limit=` up to 200, `?area=` for one part of it; `?format=csv` downloads every kept event of that part. */
export async function GET(req: Request) {
  try {
    const owner = await requireOwner();
    const params = Object.fromEntries(new URL(req.url).searchParams);
    if (params.format === "csv") {
      // The download holds every kept event of the area, so a limit is not applied (nor checked).
      const { area } = activityQuerySchema.omit({ limit: true }).parse(params);
      const day = new Date().toISOString().slice(0, 10);
      return new Response(toCsv(ACTIVITY_CSV_COLUMNS, activityRows(await listActivity(owner, MAX_ACTIVITY, area))), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="activity-${area ?? "all"}-${day}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const { limit, area } = activityQuerySchema.parse(params);
    // The area is echoed so a page can tell which filter a list it holds answers.
    return json({ events: await listActivity(owner, limit, area), area: area ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}
