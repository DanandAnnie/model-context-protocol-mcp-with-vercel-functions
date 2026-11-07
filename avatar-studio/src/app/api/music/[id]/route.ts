import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { deleteMusicJob, jobRenameSchema, renameMusicJob } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Rename one video with music: `{ title }` (1 to 120 characters) → `{ mix }`. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { title } = jobRenameSchema.parse(await readJson(req));
    return json({ mix: await renameMusicJob((await ctx.params).id, title, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Forget one video with music. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await deleteMusicJob(id, await requireEditor());
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
