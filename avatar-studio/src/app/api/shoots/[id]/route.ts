import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { deleteShoot, jobRenameSchema, renameShoot } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Rename one photo shoot: `{ title }` (1 to 120 characters) → `{ shoot }`. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { title } = jobRenameSchema.parse(await readJson(req));
    return json({ shoot: await renameShoot((await ctx.params).id, title, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Forget one photo shoot. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await deleteShoot(id, await requireEditor());
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
