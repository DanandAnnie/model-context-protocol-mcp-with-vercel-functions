import { errorResponse, json } from "@/lib/api-utils";
import { beaconAllowed } from "@/lib/beacon";
import { recordView } from "@/lib/services";

export const dynamic = "force-dynamic";

/** How long one viewer counts as the same view on the same video. */
const VIEW_WINDOW_MS = 10 * 60 * 1000;

/** Views one video can gain per window from every viewer together. */
const VIEWS_PER_VIDEO = 600;

/** Public beacon from the share page. One view per viewer per video per window; never errors on repeats. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return json(await recordView(id, () => beaconAllowed(req, "view", id, VIEWS_PER_VIDEO, VIEW_WINDOW_MS)));
  } catch (err) {
    return errorResponse(err);
  }
}
