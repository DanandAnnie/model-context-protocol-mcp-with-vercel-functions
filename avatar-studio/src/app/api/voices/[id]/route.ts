import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { deleteClonedVoice, updateClonedVoice, updateVoiceSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Renames a cloned voice; provider voices answer 404. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
    const patch = updateVoiceSchema.parse(await readJson(req));
    return json({ voice: await updateClonedVoice(id, patch, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Remove a cloned voice (and ask the provider to delete it). */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await deleteClonedVoice((await ctx.params).id, await requireOwner());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
