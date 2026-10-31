import { errorResponse, json, readJson } from "@/lib/api-utils";
import { publicOrigin } from "@/lib/config";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor, requireOwner } from "@/lib/owner";
import { deleteVideo, getVideo, updateVideo, videoPatchSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The video, plus the origin its share link is built on (the same one the share email uses). */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    return json({ video: await getVideo(id, await requireOwner()), shareOrigin: publicOrigin(req) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const owner = await requireEditor();
    const patch = videoPatchSchema.parse(await readJson(req));
    return json({ video: await updateVideo(id, patch, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Moves the video to the trash; `?permanent=true` deletes it for good. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const permanent = new URL(req.url).searchParams.get("permanent") === "true";
    const owner = await requireEditor();
    const { title, changed } = await deleteVideo(id, owner, permanent);
    // A video already in the trash is left as it is; only a change is worth a line in the feed.
    if (changed) await recordRequestActivity(owner, permanent ? "video.purged" : "video.trashed", { subject: title, subjectId: id });
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
