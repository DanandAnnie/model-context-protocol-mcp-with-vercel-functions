import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { LimitError, directedVideoScenes, editDirectedVideo, sceneEditSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Scene reads are heavy at HeyGen, with a lower limit than a video's status: a few a minute is plenty for a person. An edit reads them too. */
const READS_PER_OWNER = 60;
const WINDOW_MS = 60 * 60 * 1000;

type Ctx = { params: Promise<{ id: string }> };

/** A finished directed video's scenes, in order, with the version edits are sent against (editors only). */
function readAllowed(owner: string): void {
  const limit = rateLimit(`directedscenes:${owner}`, READS_PER_OWNER, WINDOW_MS);
  if (!limit.allowed) throw new LimitError(`Too many scene reads for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const owner = await requireEditor();
    readAllowed(owner);
    return json(await directedVideoScenes(id, owner));
  } catch (err) {
    return errorResponse(err);
  }
}

/** A new cut with the scenes named changed as described; the video edited is kept as it was. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const owner = await requireEditor();
    const input = sceneEditSchema.parse(await readJson(req));
    readAllowed(owner);
    const video = await editDirectedVideo(id, input, owner);
    if (video.status === "failed") return json({ video, error: video.error ?? "HeyGen's Video Agent could not make those changes" }, { status: 502 });
    await recordRequestActivity(owner, "video.created", { subject: video.title, subjectId: video.id });
    return json({ video }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
