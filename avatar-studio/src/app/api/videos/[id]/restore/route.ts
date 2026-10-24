import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { getVideo, recordActivity, restoreVideo } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Brings a trashed video back to the library. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
    const trashed = !!(await getVideo(id, owner, false)).deletedAt;
    const video = await restoreVideo(id, owner);
    if (trashed) await recordActivity(owner, await userOrOwner(owner), "video.restored", { subject: video.title, subjectId: id });
    return json({ video });
  } catch (err) {
    return errorResponse(err);
  }
}
