import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { ACTIVITY_CSV_COLUMNS, activityRows } from "@/lib/activity-text";
import { toCsv } from "@/lib/csv";
import { MAX_ACTIVITY, activityLinks, activityQuerySchema, lastActiveByActor, listActivity } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The account's or workspace's recent activity, newest first; `?limit=` up to 200, `?area=` for one part of it, `?actor=` for one person's; `?format=csv` downloads every kept event of that part. */
export async function GET(req: Request) {
  try {
    const owner = await requireOwner();
    const params = Object.fromEntries(new URL(req.url).searchParams);
    // `?summary=1`: when each person last did something here, for the member list; the other parameters do not apply.
    if (params.summary !== undefined) {
      activityQuerySchema.pick({ summary: true }).parse(params);
      return json({ lastActive: await lastActiveByActor(owner) });
    }
    if (params.format === "csv") {
      // The download holds every kept event of the area, so a limit is not applied (nor checked).
      const { area, actor } = activityQuerySchema.omit({ limit: true }).parse(params);
      const day = new Date().toISOString().slice(0, 10);
      return new Response(toCsv(ACTIVITY_CSV_COLUMNS, activityRows(await listActivity(owner, MAX_ACTIVITY, area, actor))), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          // A person's download says so: `-by-api-key` for scripts, else the member's id made safe for a file name.
          "Content-Disposition": `attachment; filename="activity-${area ?? "all"}${actor ? `-by-${actor === owner ? "api-key" : actor.replace(/[^\w.-]+/g, "_").slice(0, 40)}` : ""}-${day}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const { limit, area, actor, links } = activityQuerySchema.parse(params);
    // The filters are echoed so a page can tell which filters a list it holds answers.
    const events = await listActivity(owner, limit, area, actor);
    // `links` says where each line leads, for the events whose video, presenter, key, or kit is still here.
    return json({ events, links: links === "0" ? {} : await activityLinks(owner, events), area: area ?? null, actor: actor ?? null, limit });
  } catch (err) {
    return errorResponse(err);
  }
}
