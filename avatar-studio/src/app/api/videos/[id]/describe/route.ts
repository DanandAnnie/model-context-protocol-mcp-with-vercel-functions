import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { describeVideo } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A draft share-page description from the video's title and script: `{ description }`. Nothing is saved. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    return json({ description: await describeVideo((await ctx.params).id, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
