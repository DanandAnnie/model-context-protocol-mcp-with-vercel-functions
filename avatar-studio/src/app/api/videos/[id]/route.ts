import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { deleteVideo, getVideo, updateVideo, videoPatchSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    return json({ video: await getVideo(id, await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
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
    await deleteVideo(id, await requireOwner(), permanent);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
