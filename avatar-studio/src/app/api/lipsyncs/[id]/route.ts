import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { deleteLipsync, jobRenameSchema, renameLipsync } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Rename one lip-synced video: `{ title }` (1 to 120 characters) → `{ lipsync }`. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { title } = jobRenameSchema.parse(await readJson(req));
    return json({ lipsync: await renameLipsync((await ctx.params).id, title, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Forget one lip-synced video. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await deleteLipsync(id, await requireEditor());
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
