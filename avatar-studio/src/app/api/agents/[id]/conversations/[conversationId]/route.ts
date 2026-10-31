import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { deleteConversation } from "@/lib/services";

type Ctx = { params: Promise<{ id: string; conversationId: string }> };

/** Deletes one visit's transcript of a shared presenter (editors): `{ deleted: false }` when it has no such visit. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id, conversationId } = await ctx.params;
    return json({ deleted: await deleteConversation(id, conversationId, await requireEditor()) });
  } catch (err) {
    return errorResponse(err);
  }
}
