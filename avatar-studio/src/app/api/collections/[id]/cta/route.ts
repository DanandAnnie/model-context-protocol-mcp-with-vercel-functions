import { errorResponse, json } from "@/lib/api-utils";
import { beaconAllowed, crossSiteBeacon } from "@/lib/beacon";
import { clientIp, rateLimitPair } from "@/lib/rate-limit";
import { recordCollectionCtaClick } from "@/lib/services";

export const dynamic = "force-dynamic";

/** How long one visitor counts as the same click on the same folder's button. */
const CLICK_WINDOW_MS = 10 * 60 * 1000;

/** Clicks one folder's button can gain per window from every visitor together. */
const CLICKS_PER_FOLDER = 300;

/**
 * Beacons taken at all per visitor and per folder per window, counted or not. The folder's ceiling is the one its open
 * beacon uses (the same key), so the two together queue no more on the folder's turn than opens alone could.
 */
const HITS_PER_VISITOR = 30;
const HITS_PER_FOLDER = 3000;

/**
 * Public beacon from a shared folder's button: one click per visitor per folder per window; the body is ignored. A
 * request from another site is `{ "counted": false }` without looking at the folder, one past the visitor's or the
 * folder's ceiling on beacons (shared with its opens) is a 429, a page without a button counts nothing, and a link that
 * is not shared, or a button on a folder that holds no video, is a 404. Repeats are never an error.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (crossSiteBeacon(req)) return json({ counted: false });
    if (!rateLimitPair(`foldercta-hit:${clientIp(req)}:${id}`, HITS_PER_VISITOR, `folderhit:folder:${id}`, HITS_PER_FOLDER, CLICK_WINDOW_MS).allowed) return json({ counted: false }, { status: 429 });
    return json(await recordCollectionCtaClick(id, () => beaconAllowed(req, "foldercta", id, CLICKS_PER_FOLDER, CLICK_WINDOW_MS)));
  } catch (err) {
    return errorResponse(err);
  }
}
