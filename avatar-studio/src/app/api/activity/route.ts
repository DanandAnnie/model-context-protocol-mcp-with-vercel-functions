import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { activityQuerySchema, listActivity } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The account's or workspace's recent activity, newest first; `?limit=` up to 200, `?area=` for one part of it. */
export async function GET(req: Request) {
  try {
    const owner = await requireOwner();
    const { limit, area } = activityQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    // The area is echoed so a page can tell which filter a list it holds answers.
    return json({ events: await listActivity(owner, limit, area), area: area ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}
