import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { agentPatchSchema, deleteAgent, getAgent, updateAgent } from "@/lib/services";

export const dynamic = "force-dynamic";
/** Creating or editing may read a knowledge page (10 s fetch budget). */
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    return json({ agent: await getAgent((await ctx.params).id, await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const owner = await requireOwner();
    const patch = agentPatchSchema.parse(await readJson(req));
    return json({ agent: await updateAgent((await ctx.params).id, patch, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await deleteAgent((await ctx.params).id, await requireOwner());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
