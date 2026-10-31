import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { deleteCleanup, jobRenameSchema, renameCleanup } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Rename one cleaned recording: `{ title }` (1 to 120 characters) → `{ cleanup }`. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { title } = jobRenameSchema.parse(await readJson(req));
    return json({ cleanup: await renameCleanup((await ctx.params).id, title, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Forget one cleaned recording. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await deleteCleanup(id, await requireEditor());
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
