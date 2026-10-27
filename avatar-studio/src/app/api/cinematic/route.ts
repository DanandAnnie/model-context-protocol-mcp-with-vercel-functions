import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor } from "@/lib/owner";
import { cinematicKeySchema, cinematicSchema, startCinematic } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Start a cinematic shot with `{ prompt, avatarIds, aspect?, resolution?, duration?, enhancePrompt?, title?, folder? }` as a library video. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = cinematicSchema.parse(await readJson(req));
    // A client key makes a shot retried after a lost answer return the same video instead of directing another.
    const header = req.headers.get("idempotency-key");
    // Set only by the request that started the render here; a replay of one started before is not a second "created".
    let started = false;
    const video = await startCinematic(input, owner, { key: header ? cinematicKeySchema.parse(header) : undefined, onStarted: () => (started = true) });
    if (video.status === "failed") return json({ video, error: video.error ?? "The shot could not be started" }, { status: 502 });
    if (started) await recordRequestActivity(owner, "video.created", { subject: video.title, subjectId: video.id });
    return json({ video }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
