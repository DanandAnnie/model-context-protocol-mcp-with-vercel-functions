import { errorResponse, json, readJson } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { LimitError, fixVideoLines, lineFixSchema } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Fixes an account may send per hour: each reads the video's scenes at the renderer and re-renders some of them. */
const FIXES_PER_OWNER = 30;
const WINDOW_MS = 60 * 60 * 1000;

type Ctx = { params: Promise<{ id: string }> };

/**
 * New words for spoken lines of a finished video: `{ scenes: [{ scene, from, script }] }`. The renderer re-renders only
 * those scenes, in place; the video keeps its id and link and is followed again until the new render is ready.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const owner = await requireEditor();
    const input = lineFixSchema.parse(await readJson(req));
    const limit = rateLimit(`linefix:${owner}`, FIXES_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) throw new LimitError(`Too many fixes for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    const { video, sent } = await fixVideoLines(id, input, owner);
    // A retried request answered with the fix already sent is not recorded again.
    if (sent && video.lineFix && !video.lineFix.error) await recordRequestActivity(owner, "video.lines_fixed", { subject: video.title, subjectId: video.id });
    return json({ video });
  } catch (err) {
    return errorResponse(err);
  }
}
