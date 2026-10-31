import { errorResponse, json, readJson } from "@/lib/api-utils";
import { cookies } from "next/headers";
import { beaconAllowed } from "@/lib/beacon";
import { shareCookieName } from "@/lib/share-lock";
import { recordChapterView, recordWatch, watchSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

/** How long one viewer counts as the same viewer on the same video. */
const WATCH_WINDOW_MS = 10 * 60 * 1000;

/** Counts one video can gain per quarter (or chapter) per window from every viewer together. */
const WATCHES_PER_VIDEO = 600;

/**
 * Public beacon from the share-page player: `{ "quarter": 25 | 50 | 75 | 100 }`, the furthest
 * point reached, every quarter up to it counted once per viewer per window in one write; or
 * `{ "scene": n }`, the chapter being played, by the scene it opens, once per viewer per chapter per window.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = watchSchema.parse(await readJson(req));
    const unlock = (await cookies()).get(shareCookieName(id))?.value;
    if ("scene" in body) {
      const { scene } = body;
      return json(await recordChapterView(id, scene, () => beaconAllowed(req, `chapter${scene}`, id, WATCHES_PER_VIDEO, WATCH_WINDOW_MS), unlock));
    }
    return json(await recordWatch(id, body.quarter, (q) => beaconAllowed(req, `watch${q}`, id, WATCHES_PER_VIDEO, WATCH_WINDOW_MS), unlock));
  } catch (err) {
    return errorResponse(err);
  }
}
