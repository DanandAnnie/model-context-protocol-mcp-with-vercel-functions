import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { commentPatchSchema, deleteComment, resolveComment } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; commentId: string }> }) {
  try {
    const owner = await requireOwner();
    const { id, commentId } = await ctx.params;
    const author = await userOrOwner(owner);
    await deleteComment(id, commentId, owner, author);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** `{ resolved }` marks the note done or open again; anyone who can comment on the video may. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; commentId: string }> }) {
  try {
    const owner = await requireOwner();
    const { id, commentId } = await ctx.params;
    const { resolved } = commentPatchSchema.parse(await readJson(req));
    return json({ comment: await resolveComment(id, commentId, resolved, owner, await userOrOwner(owner)) });
  } catch (err) {
    return errorResponse(err);
  }
}
