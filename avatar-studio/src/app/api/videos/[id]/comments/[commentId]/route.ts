import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { commentPatchSchema, deleteComment, editComment, notifyMentions, resolveComment } from "@/lib/services";
import { afterResponse } from "@/lib/services/shared";

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

/** `{ resolved }` marks the note done or open again, as anyone who can comment may; `{ text }` edits the author's own note. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; commentId: string }> }) {
  try {
    const owner = await requireOwner();
    const { id, commentId } = await ctx.params;
    const patch = commentPatchSchema.parse(await readJson(req));
    const user = await userOrOwner(owner);
    if ("resolved" in patch) {
      const comment = await resolveComment(id, commentId, patch.resolved, owner, user);
      return json({ comment: { ...comment, mine: comment.authorId === user.id } });
    }
    const { comment, newMentions } = await editComment(id, commentId, patch.text, owner, user);
    // Only members the note never named before are emailed, after the response, as for a new comment.
    if (newMentions?.length) await afterResponse(() => notifyMentions({ ...comment, mentions: newMentions }));
    return json({ comment: { ...comment, mine: true } });
  } catch (err) {
    return errorResponse(err);
  }
}
