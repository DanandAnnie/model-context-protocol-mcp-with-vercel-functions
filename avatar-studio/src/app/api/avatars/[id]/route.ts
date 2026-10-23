import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { deleteAvatar, getAvatar, updateAvatar, updateAvatarSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    return json({ avatar: await getAvatar(id, await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Renames a photo avatar or changes its gender; library presenters answer 404. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
    const patch = updateAvatarSchema.parse(await readJson(req));
    return json({ avatar: await updateAvatar(id, patch, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await deleteAvatar(id, await requireOwner());
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
