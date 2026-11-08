import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { deleteHighlights } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Forget one set of the video's highlight clips. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; jobId: string }> }) {
  try {
    const { id, jobId } = await ctx.params;
    await deleteHighlights(id, jobId, await requireEditor());
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
