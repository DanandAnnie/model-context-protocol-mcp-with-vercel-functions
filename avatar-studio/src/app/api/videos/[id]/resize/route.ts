import { recordRequestActivity } from "@/lib/activity-request";
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
    const result = await resizeVideo(id, resizeSchema.parse(await readJson(req)), owner);
    for (const video of result.videos) await recordRequestActivity(owner, "video.created", { subject: video.title, subjectId: video.id });
    return json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
