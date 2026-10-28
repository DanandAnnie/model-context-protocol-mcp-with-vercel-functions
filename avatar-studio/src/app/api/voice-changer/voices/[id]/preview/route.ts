import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { instantVoicePreview } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Previews an account may ask for per hour: one per press of a voice's Listen button. */
const PREVIEWS_PER_OWNER = 600;
const WINDOW_MS = 60 * 60 * 1000;

/**
 * A link to one of the account's instant voices reading a short preview script (viewers too). The renderer signs it
 * for a limited time, so it is asked for on each listen and not cached.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
    const limit = rateLimit(`voicepreview:${owner}`, PREVIEWS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many previews for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ previewUrl: await instantVoicePreview(id, owner) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
