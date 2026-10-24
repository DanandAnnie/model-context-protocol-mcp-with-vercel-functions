import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { deleteTemplate, getTemplate } from "@/lib/services";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    return json({ template: await getTemplate(id, await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await deleteTemplate(id, await requireEditor());
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
