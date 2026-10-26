import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { ValidationError, dubProofread, proofreadLinesSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Dubs a proofread's lines, with `{ lines }` corrections when sent (an empty body dubs them as they are). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const owner = await requireEditor();
    const text = await req.text();
    const input = text.trim() ? proofreadLinesSchema.parse(JSON.parse(text)) : undefined;
    const translation = await dubProofread(id, input, owner);
    // The provider refused: the lines stay open and the job says why.
    if (translation.proofreadStage === "ready") return json({ translation, error: translation.error }, { status: 502 });
    return json({ translation });
  } catch (err) {
    return errorResponse(err instanceof SyntaxError ? new ValidationError("Request body must be JSON") : err);
  }
}
