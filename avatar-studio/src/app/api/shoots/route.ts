import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimit, rateLimitPair } from "@/lib/rate-limit";
import { LimitError, listShoots, publicShoot, shootKeySchema, shootRequestSchema, shootsAvailable, startShoot } from "@/lib/services";

export const dynamic = "force-dynamic";
/** A start carries up to six pictures of up to 500 KB each on to the renderer. */
export const maxDuration = 60;

/**
 * Shoots an account may start per hour, and every account together: each one is paid for with the renderer.
 * Counted per server instance, as the other limits are.
 */
const PER_OWNER = 20;
const PER_INSTANCE = 60;
/** Listings an account may make per hour: the page asks every few seconds while a shoot is being made. */
const LISTS_PER_OWNER = 1500;
const WINDOW_MS = 60 * 60 * 1000;

/** The account's photo shoots, newest first; any still being made is checked on the way. */
export async function GET() {
  try {
    const owner = await requireOwner();
    const limit = rateLimit(`shootlist:${owner}`, LISTS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many checks for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ shoots: (await listShoots(owner)).map(publicShoot), available: shootsAvailable() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Start a photo shoot: `{ identity, reference, consent: true, aspect?, count?, seed?, title? }`. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = shootRequestSchema.parse(await readJson(req, "The pictures are too large: each one is at most 500 KB"));
    // A client key makes a retried start return the same shoot instead of paying for another.
    const header = req.headers.get("idempotency-key");
    const key = header ? shootKeySchema.parse(header) : undefined;
    // Counted only once the request is checked and new, so a refused or repeated start does not use up the hour's starts.
    const admit = () => {
      const limit = rateLimitPair(`shoot:${owner}`, PER_OWNER, "shoot:*", PER_INSTANCE, WINDOW_MS);
      if (!limit.allowed) throw new LimitError(`Too many photo shoots for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    };
    return json({ shoot: publicShoot(await startShoot(input, owner, { key, admit })) }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
