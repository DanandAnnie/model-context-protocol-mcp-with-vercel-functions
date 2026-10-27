import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimit, rateLimitPair } from "@/lib/rate-limit";
import { LimitError, footageAvailable, footageKeySchema, footageRequestSchema, listFootage, publicFootage, startFootage } from "@/lib/services";

export const dynamic = "force-dynamic";
/** A start carries a picture of up to 3 MB on to the renderer. */
export const maxDuration = 60;

/**
 * Clips an account may start per hour, and every account together: each one is paid for with the renderer.
 * Counted per server instance, as the other limits are.
 */
const PER_OWNER = 20;
const PER_INSTANCE = 60;
/** Listings an account may make per hour: the page asks every ten seconds while a clip is being made. */
const LISTS_PER_OWNER = 1500;
const WINDOW_MS = 60 * 60 * 1000;

/** The account's generated clips, newest first; any still being made is checked on the way. */
export async function GET() {
  try {
    const owner = await requireOwner();
    const limit = rateLimit(`footagelist:${owner}`, LISTS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many checks for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ footage: (await listFootage(owner)).map(publicFootage), available: footageAvailable() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Generate a clip: `{ prompt, durationSec?, aspect?, quality?, image?, title? }`. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = footageRequestSchema.parse(await readJson(req));
    // A client key makes a retried start return the same clip instead of paying for another.
    const header = req.headers.get("idempotency-key");
    const key = header ? footageKeySchema.parse(header) : undefined;
    // Counted only once the request is checked and new, so a refused or repeated start does not use up the hour's starts.
    const admit = () => {
      const limit = rateLimitPair(`footage:${owner}`, PER_OWNER, "footage:*", PER_INSTANCE, WINDOW_MS);
      if (!limit.allowed) throw new LimitError(`Too many clips for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    };
    return json({ footage: publicFootage(await startFootage(input, owner, { key, admit })) }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
