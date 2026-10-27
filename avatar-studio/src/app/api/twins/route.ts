import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimit, rateLimitPair } from "@/lib/rate-limit";
import { LimitError, listTwins, publicTwin, startTwin, twinKeySchema, twinRequestSchema, twinsAvailable } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Twins an account may start per hour, and every account together: each one is paid for with the renderer.
 * Counted per server instance, as the other limits are.
 */
const PER_OWNER = 5;
const PER_INSTANCE = 20;
/** Listings an account may make per hour: the page asks every ten seconds while a twin is trained or waits for consent. */
const LISTS_PER_OWNER = 1500;
const WINDOW_MS = 60 * 60 * 1000;

/** The account's digital twins, newest first; one still being trained or consented to is checked on the way. */
export async function GET() {
  try {
    const owner = await requireOwner();
    const limit = rateLimit(`twinlist:${owner}`, LISTS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many checks for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    // The consent link is the person's to record consent with, so a viewer of a workspace is not handed it.
    const canEdit = await requireEditor().then(
      () => true,
      () => false,
    );
    const now = Date.now();
    return json({ twins: (await listTwins(owner)).map((t) => publicTwin(t, now, canEdit)), available: twinsAvailable() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Train a digital twin: `{ name, footageUrl, gender?, agreed: true }`. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = twinRequestSchema.parse(await readJson(req));
    // A client key makes a retried start return the same twin instead of paying for another.
    const header = req.headers.get("idempotency-key");
    const key = header ? twinKeySchema.parse(header) : undefined;
    // Counted only once the request is checked and new, so a refused or repeated start does not use up the hour's starts.
    const admit = () => {
      const limit = rateLimitPair(`twin:${owner}`, PER_OWNER, "twin:*", PER_INSTANCE, WINDOW_MS);
      if (!limit.allowed) throw new LimitError(`Too many digital twins for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    };
    return json({ twin: publicTwin(await startTwin(input, owner, { key, admit })) }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
