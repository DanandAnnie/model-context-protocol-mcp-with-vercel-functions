import { errorResponse, json } from "@/lib/api-utils";
import { cookies } from "next/headers";
import { beaconAllowed } from "@/lib/beacon";
import { shareCookieName } from "@/lib/share-lock";
import { recordView, viewSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

/** How long one viewer counts as the same view on the same video. */
const VIEW_WINDOW_MS = 10 * 60 * 1000;

/** Views one video can gain per window from every viewer together. */
const VIEWS_PER_VIDEO = 600;

/**
 * Public beacon from the share page: `{ "place": "page" | "embed" }` says where the player is. A body that is not JSON
 * (none at all, from an older page) is the share page, and other fields are ignored, so a view is never lost to its
 * body; only a place that is neither is refused. One view per viewer per video per window, wherever it plays; never
 * errors on repeats.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const text = (await req.text()).trim();
    let raw: unknown = {};
    try {
      if (text) raw = JSON.parse(text);
    } catch {
      raw = {};
    }
    const { place = "page" } = viewSchema.parse(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {});
    const unlock = (await cookies()).get(shareCookieName(id))?.value;
    return json(await recordView(id, () => beaconAllowed(req, "view", id, VIEWS_PER_VIDEO, VIEW_WINDOW_MS), unlock, place));
  } catch (err) {
    return errorResponse(err);
  }
}
