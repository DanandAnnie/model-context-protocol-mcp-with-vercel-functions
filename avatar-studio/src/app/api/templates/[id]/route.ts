import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { deleteTemplate, editTemplate, getTemplate, templateEditSchema } from "@/lib/services";

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

/** Rename a template or change its description: `{ title?, description? }` (`description: null` or blank removes it) → `{ template }`. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const owner = await requireEditor();
    const input = templateEditSchema.parse(await readJson(req));
    return json({ template: await editTemplate((await ctx.params).id, input, owner) });
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
