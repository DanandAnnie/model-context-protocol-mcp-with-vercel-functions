import { errorResponse, json } from "@/lib/api-utils";
import { deleteVideo, getVideo } from "@/lib/services";

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

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await deleteVideo(id);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
