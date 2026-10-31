import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { rateLimitPair } from "@/lib/rate-limit";
import { listPublicVoices, publicVoicesAvailable } from "@/lib/services";

export const dynamic = "force-dynamic";
// HeyGen is asked page by page when the list is not kept, each page within a few seconds.
export const maxDuration = 60;

/** Listings an account may make per hour (the Voice changer asks once when it opens), and all accounts on one instance. */
const LISTS_PER_OWNER = 600;
const LISTS_PER_INSTANCE = 3000;
const WINDOW_MS = 60 * 60 * 1000;

/** HeyGen's public voices to speak text in, by name, with a sample of each (viewers too). */
export async function GET() {
  try {
    const owner = await requireOwner();
    const limit = rateLimitPair(`publicvoices:${owner}`, LISTS_PER_OWNER, "publicvoices:*", LISTS_PER_INSTANCE, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many checks for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ voices: await listPublicVoices(), available: publicVoicesAvailable() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
