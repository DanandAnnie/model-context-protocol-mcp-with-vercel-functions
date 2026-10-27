import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { deleteVoiceChange } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Forget one recording spoken again. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await deleteVoiceChange(id, await requireEditor());
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
