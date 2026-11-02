import { errorResponse, json, readJson } from "@/lib/api-utils";
import { ValidationError } from "@/lib/errors";
import { requireOwner, userOrOwner } from "@/lib/owner";
import { commentPatchSchema, deleteComment, editComment, notifyMentions, resolveComment } from "@/lib/services";
import { afterResponse } from "@/lib/services/shared";

export const dynamic = "force-dynamic";

/** `?replies=N` is how many replies the caller saw on the note and agreed to delete with it; more now is a 409. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; commentId: string }> }) {
  try {
    const owner = await requireOwner();
    const { id, commentId } = await ctx.params;
    const author = await userOrOwner(owner);
    const asked = new URL(req.url).searchParams.get("replies");
    // Present but not a count is refused, rather than read as "no guard" and every reply deleted.
    if (asked !== null && !/^\d{1,4}$/.test(asked)) throw new ValidationError("replies must be the number of replies you saw, 0 to 9999");
    const expected = asked !== null ? Number(asked) : undefined;
    await deleteComment(id, commentId, owner, author, expected);
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
