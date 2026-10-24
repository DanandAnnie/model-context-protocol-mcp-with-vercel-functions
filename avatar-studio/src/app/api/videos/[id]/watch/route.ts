import { errorResponse, json, readJson } from "@/lib/api-utils";
import { cookies } from "next/headers";
import { beaconAllowed } from "@/lib/beacon";
import { shareCookieName } from "@/lib/share-lock";
import { recordWatch, watchSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

/** How long one viewer counts as the same viewer on the same video. */
const WATCH_WINDOW_MS = 10 * 60 * 1000;

/** Counts one video can gain per quarter per window from every viewer together. */
const WATCHES_PER_VIDEO = 600;

/**
 * Public beacon from the share-page player: `{ "quarter": 25 | 50 | 75 | 100 }`, the furthest
 * point reached. Every quarter up to it counts once per viewer per window, in one write.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { quarter } = watchSchema.parse(await readJson(req));
    const unlock = (await cookies()).get(shareCookieName(id))?.value;
    return json(await recordWatch(id, quarter, (q) => beaconAllowed(req, `watch${q}`, id, WATCHES_PER_VIDEO, WATCH_WINDOW_MS), unlock));
  } catch (err) {
    return errorResponse(err);
  }
}
