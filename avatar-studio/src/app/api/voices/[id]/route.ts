import { errorResponse } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { deleteClonedVoice } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Remove a cloned voice (and ask the provider to delete it). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await deleteClonedVoice((await ctx.params).id, await requireOwner());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
