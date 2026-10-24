import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { activityQuerySchema, listActivity } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The account's or workspace's recent activity, newest first; `?limit=` up to 200. */
export async function GET(req: Request) {
  try {
    const owner = await requireOwner();
    const { limit } = activityQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    return json({ events: await listActivity(owner, limit) });
  } catch (err) {
    return errorResponse(err);
  }
}
