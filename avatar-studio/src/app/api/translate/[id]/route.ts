import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { getTranslation, proofreadLinesSchema, saveProofreadLines } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return json({ translation: await getTranslation(id, await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Saves corrections to a proofread's lines: `{ lines: string[] }`, one text per line. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const owner = await requireEditor();
    const input = proofreadLinesSchema.parse(await readJson(req));
    return json({ translation: await saveProofreadLines(id, input, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
