import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { publicTwin, requestTwinConsent } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Consent links an account may ask for per hour (a link lasts a day; a new one is needed only after it expires or is refused). */
const PER_OWNER = 20;
const WINDOW_MS = 60 * 60 * 1000;

/** A page for the person in the footage to record their consent on, valid for a day → `{ twin }` with `consentUrl`. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const limit = rateLimit(`twinconsent:${owner}`, PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many consent links for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    const { id } = await ctx.params;
    return json({ twin: publicTwin(await requestTwinConsent(id, owner)) });
  } catch (err) {
    return errorResponse(err);
  }
}
