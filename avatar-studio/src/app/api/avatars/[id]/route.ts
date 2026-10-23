import { errorResponse, json } from "@/lib/api-utils";
import { deleteAvatar, getAvatar } from "@/lib/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    return json({ avatar: await getAvatar(id) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await deleteAvatar(id);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
