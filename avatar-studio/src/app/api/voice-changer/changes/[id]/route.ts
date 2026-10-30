import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { deleteVoiceChange, jobRenameSchema, renameVoiceChange } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Rename one recording spoken in a voice: `{ title }` (1 to 120 characters) → `{ change }`. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { title } = jobRenameSchema.parse(await readJson(req));
    return json({ change: await renameVoiceChange((await ctx.params).id, title, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Forget one recording spoken again. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await deleteVoiceChange(id, await requireEditor());
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
