import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { resizeSchema, resizeVideo } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Render the video again in other aspect ratios ("Make other sizes"), one new video each. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const owner = await requireEditor();
    const videos = await resizeVideo(id, resizeSchema.parse(await readJson(req)), owner);
    return json({ videos }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
