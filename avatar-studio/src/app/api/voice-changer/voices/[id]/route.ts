import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { deleteInstantVoice } from "@/lib/services";

export const dynamic = "force-dynamic";

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
