import { errorResponse, json } from "@/lib/api-utils";
import { cookies } from "next/headers";
import { beaconAllowed } from "@/lib/beacon";
import { shareCookieName } from "@/lib/share-lock";
import { recordCtaClick } from "@/lib/services";

export const dynamic = "force-dynamic";

/** How long one viewer counts as the same click on the same video. */
const CLICK_WINDOW_MS = 10 * 60 * 1000;

/** Clicks one video can gain per window from every viewer together. */
const CLICKS_PER_VIDEO = 300;

/** Public beacon from the share page's call to action. One click per viewer per video per window; never errors on repeats. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const unlock = (await cookies()).get(shareCookieName(id))?.value;
    return json(await recordCtaClick(id, () => beaconAllowed(req, "cta", id, CLICKS_PER_VIDEO, CLICK_WINDOW_MS), unlock));
  } catch (err) {
    return errorResponse(err);
  }
}
