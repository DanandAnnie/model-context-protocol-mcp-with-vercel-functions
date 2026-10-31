import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { LimitError, publicTwin, requestTwinConsent } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Consent links an account may ask for per hour (a link lasts a day; a new one is needed only after it expires or is refused). */
const PER_OWNER = 20;
const WINDOW_MS = 60 * 60 * 1000;

/** A page for the person in the footage to record their consent on, valid for a day → `{ twin }` with `consentUrl`. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { id } = await ctx.params;
    // Counted only when a new link is asked for of the renderer; the one still valid is handed back as it is.
    const admit = () => {
      const limit = rateLimit(`twinconsent:${owner}`, PER_OWNER, WINDOW_MS);
      if (!limit.allowed) throw new LimitError("Too many consent links for now; try again later");
    };
    return json({ twin: publicTwin(await requestTwinConsent(id, owner, { admit })) });
  } catch (err) {
    return errorResponse(err);
  }
}
