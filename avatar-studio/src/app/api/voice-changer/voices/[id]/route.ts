import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { deleteInstantVoice, instantVoiceRenameSchema, renameInstantVoice } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Rename one instant voice: `{ name }` (1 to 60 characters, not another voice's) → `{ voice }`. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { name } = instantVoiceRenameSchema.parse(await readJson(req));
    return json({ voice: await renameInstantVoice((await ctx.params).id, name, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Delete one instant voice, at the renderer too. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await deleteInstantVoice(id, await requireEditor());
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
