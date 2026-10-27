import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor } from "@/lib/owner";
import { renderStudioTemplate, studioRenderKeySchema, studioRenderSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Render the template with `{ title, captions?, variables }` as a library video. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { id } = await ctx.params;
    const input = studioRenderSchema.parse(await readJson(req));
    // A client key makes a render retried after a lost answer return the same video instead of rendering another.
    const header = req.headers.get("idempotency-key");
    // Set only by the request that started the render here; a replay of one started before is not a second "created".
    let started = false;
    const video = await renderStudioTemplate(id, input, owner, { key: header ? studioRenderKeySchema.parse(header) : undefined, onStarted: () => (started = true) });
    if (video.status === "failed") return json({ video, error: video.error ?? "The render could not be started" }, { status: 502 });
    if (started) await recordRequestActivity(owner, "video.created", { subject: video.title, subjectId: video.id });
    return json({ video }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
