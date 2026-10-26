import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { portraitStatus } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Where a portrait stands; a finished one comes back as a data URL to save as a photo avatar. */
export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  try {
    await requireEditor();
    const { jobId } = await ctx.params;
    return json(await portraitStatus(jobId));
  } catch (err) {
    return errorResponse(err);
  }
}
