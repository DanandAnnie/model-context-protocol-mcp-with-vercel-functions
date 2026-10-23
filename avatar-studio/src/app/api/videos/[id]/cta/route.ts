import { errorResponse, json } from "@/lib/api-utils";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { recordCtaClick } from "@/lib/services";

export const dynamic = "force-dynamic";

/** How long one viewer counts as the same click on the same video. */
const CLICK_WINDOW_MS = 10 * 60 * 1000;

/** Public beacon from the share page's call to action. One click per viewer per video per window; never errors on repeats. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const key = `cta:${clientIp(req)}:${id}`;
    return json(await recordCtaClick(id, () => rateLimit(key, 1, CLICK_WINDOW_MS).allowed));
  } catch (err) {
    return errorResponse(err);
  }
}
