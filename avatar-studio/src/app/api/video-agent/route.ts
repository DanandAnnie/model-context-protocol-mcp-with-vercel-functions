import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor } from "@/lib/owner";
import { generateAgentVideo, planVideo, videoAgentSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** One prompt to a video: `mode: "plan"` returns the draft for the editor, otherwise it renders straight away. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = videoAgentSchema.parse(await readJson(req));
    if (input.mode === "plan") return json({ draft: await planVideo(input, owner) });
    const { video, draft } = await generateAgentVideo(input, owner);
    if (video.status === "failed") return json({ video, draft, error: video.error ?? "The render could not be started" }, { status: 502 });
    await recordRequestActivity(owner, "video.created", { subject: video.title, subjectId: video.id });
    return json({ video, draft }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
