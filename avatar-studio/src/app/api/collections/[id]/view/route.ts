import { errorResponse, json } from "@/lib/api-utils";
import { beaconAllowed, crossSiteBeacon } from "@/lib/beacon";
import { clientIp, rateLimitPair } from "@/lib/rate-limit";
import { recordCollectionView } from "@/lib/services";

export const dynamic = "force-dynamic";

/** How long one visitor counts as the same open of the same shared folder. */
const VIEW_WINDOW_MS = 10 * 60 * 1000;

/** Opens one shared folder can gain per window from every visitor together. */
const VIEWS_PER_FOLDER = 600;

/**
 * Beacons taken at all per visitor and per folder per window, counted or not. Each one waits its turn on the folder
 * (where stopping and renaming wait too) and lists the owner's videos, so a flood is turned away before it queues.
 */
const HITS_PER_VISITOR = 30;
const HITS_PER_FOLDER = 3000;

/**
 * Public beacon from a shared folder's page: one open per visitor per folder per window; the body is ignored. A
 * request from another site is `{ "counted": false }` without looking at the folder, and one past the visitor's or the
 * folder's ceiling on beacons is a 429. A link that no longer shows a page is 404; repeats are never an error.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (crossSiteBeacon(req)) return json({ counted: false });
    if (!rateLimitPair(`folderhit:${clientIp(req)}:${id}`, HITS_PER_VISITOR, `folderhit:folder:${id}`, HITS_PER_FOLDER, VIEW_WINDOW_MS).allowed) return json({ counted: false }, { status: 429 });
    return json(await recordCollectionView(id, () => beaconAllowed(req, "folder", id, VIEWS_PER_FOLDER, VIEW_WINDOW_MS)));
  } catch (err) {
    return errorResponse(err);
  }
}
