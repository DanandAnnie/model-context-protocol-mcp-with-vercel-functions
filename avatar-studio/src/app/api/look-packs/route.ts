import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor, requireOwner } from "@/lib/owner";
import { rateLimit, rateLimitPair } from "@/lib/rate-limit";
import { LimitError, listLookPacks, lookPackKeySchema, lookPackRequestSchema, lookPacksAvailable, publicLookPack, startLookPack } from "@/lib/services";

export const dynamic = "force-dynamic";
/** A first start may make the photo avatar first (an upload, then a wait for HeyGen) before asking for the looks. */
export const maxDuration = 60;

/**
 * Look packs an account may start per hour, and every account together: each one is paid for with the renderer.
 * Counted per server instance, as the other limits are.
 */
const PER_OWNER = 10;
const PER_INSTANCE = 40;
/** Listings an account may make per hour: the page asks every ten seconds while a pack is being made. */
const LISTS_PER_OWNER = 1500;
const WINDOW_MS = 60 * 60 * 1000;

/** The account's look packs, newest first; one still being made is checked on the way. */
export async function GET() {
  try {
    const owner = await requireOwner();
    const limit = rateLimit(`lookpacklist:${owner}`, LISTS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many checks for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ lookPacks: (await listLookPacks(owner)).map(publicLookPack), available: lookPacksAvailable() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** New looks for one of the account's photo avatars: `{ avatarId, pack, gender?, aspect? }`. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = lookPackRequestSchema.parse(await readJson(req));
    // A client key makes a retried start return the same look pack instead of paying for another.
    const header = req.headers.get("idempotency-key");
    const key = header ? lookPackKeySchema.parse(header) : undefined;
    // Counted only once the request is checked and new, so a refused or repeated start does not use up the hour's starts.
    const admit = () => {
      const limit = rateLimitPair(`lookpack:${owner}`, PER_OWNER, "lookpack:*", PER_INSTANCE, WINDOW_MS);
      if (!limit.allowed) throw new LimitError(`Too many look packs for now; try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes`);
    };
    return json({ lookPack: publicLookPack(await startLookPack(input, owner, { key, admit })) }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
