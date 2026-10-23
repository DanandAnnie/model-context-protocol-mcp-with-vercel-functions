import { errorResponse } from "@/lib/api-utils";
import { currentUser, requireOwner } from "@/lib/owner";
import { deleteComment } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; commentId: string }> }) {
  try {
    const owner = await requireOwner();
    const { id, commentId } = await ctx.params;
    const author = await currentUser().catch(() => ({ id: owner }));
    await deleteComment(id, commentId, owner, author);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
