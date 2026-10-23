import { errorResponse, json, readJson } from "@/lib/api-utils";
import { deleteVideo, getVideo, updateVideo, videoPatchSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    return json({ video: await getVideo(id) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const patch = videoPatchSchema.parse(await readJson(req));
    return json({ video: await updateVideo(id, patch) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await deleteVideo(id);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
