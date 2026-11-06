import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { z } from "zod";
import { LimitError, ValidationError, publicTwin, requestTwinConsent, submitTwinConsentVideo } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Consent links an account may ask for per hour (a link lasts a day; a new one is needed only after it expires or is refused). */
const PER_OWNER = 20;
const WINDOW_MS = 60 * 60 * 1000;
/** Uploads an account may ask the renderer to finish per hour, shared with twins started from uploaded footage. */
const FINISHES_PER_OWNER = 30;

/** A recorded consent video sent in place of the link: the token of a file uploaded with purpose "consent". */
const consentVideoSchema = z.object({ upload: z.string().min(1, "Upload the consent video first").max(4000, "Unknown upload") }).strict();

/**
 * A page for the person in the footage to record their consent on, valid for a day → `{ twin }` with `consentUrl`; or,
 * with `{ upload }`, a recorded consent video submitted for review in its place → `{ twin }` with `consentVideo`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { id } = await ctx.params;
    const text = await req.text();
    let body: unknown;
    try {
      body = text.trim() ? JSON.parse(text) : undefined;
    } catch {
      throw new ValidationError("The request body is not valid JSON");
    }
    // Counted only when a new link is asked for of the renderer; the one still valid is handed back as it is.
    const admit = () => {
      const limit = rateLimit(`twinconsent:${owner}`, PER_OWNER, WINDOW_MS);
      if (!limit.allowed) throw new LimitError("Too many consent requests for now; try again later");
    };
    // A body naming an upload sends a consent video; none (or one without `upload`, such as `{}`) asks for a link.
    if (body && typeof body === "object" && "upload" in body) {
      const finish = () => {
        const limit = rateLimit(`twinfinish:${owner}`, FINISHES_PER_OWNER, WINDOW_MS);
        if (!limit.allowed) throw new LimitError(`Too many tries for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
      };
      return json({ twin: publicTwin(await submitTwinConsentVideo(id, consentVideoSchema.parse(body).upload, owner, { admit, finish })) });
    }
    return json({ twin: publicTwin(await requestTwinConsent(id, owner, { admit })) });
  } catch (err) {
    return errorResponse(err);
  }
}
