import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor } from "@/lib/owner";
import { renderStudioTemplate, studioRenderSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Render the template with `{ title, captions?, variables }` as a library video. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { id } = await ctx.params;
    const input = studioRenderSchema.parse(await readJson(req));
    const video = await renderStudioTemplate(id, input, owner);
    if (video.status === "failed") return json({ video, error: video.error ?? "The render could not be started" }, { status: 502 });
    await recordRequestActivity(owner, "video.created", { subject: video.title, subjectId: video.id });
    return json({ video }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
