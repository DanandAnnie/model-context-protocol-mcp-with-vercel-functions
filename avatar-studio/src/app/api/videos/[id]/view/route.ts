import { errorResponse, json } from "@/lib/api-utils";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { recordView } from "@/lib/services";

export const dynamic = "force-dynamic";

/** How long one viewer counts as the same view on the same video. */
const VIEW_WINDOW_MS = 10 * 60 * 1000;

/** Public beacon from the share page. One view per viewer per video per window; never errors on repeats. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const key = `view:${clientIp(req)}:${id}`;
    return json(await recordView(id, () => rateLimit(key, 1, VIEW_WINDOW_MS).allowed));
  } catch (err) {
    return errorResponse(err);
  }
}
