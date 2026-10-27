import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { listInstantVoices, listVoiceChanges, publicInstantVoice, publicVoiceChange, voiceChangerAvailable } from "@/lib/services";

export const dynamic = "force-dynamic";
// A conversion still running is asked for again on the way, which can take a few seconds.
export const maxDuration = 30;

/** Listings an account may make per hour: the page asks every few seconds while a voice or a recording is being made. */
const LISTS_PER_OWNER = 1500;
const WINDOW_MS = 60 * 60 * 1000;

/** The account's instant voices and recordings spoken again, newest first (viewers too). */
export async function GET() {
  try {
    const owner = await requireOwner();
    const limit = rateLimit(`voicechangerlist:${owner}`, LISTS_PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many checks for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    const [voices, changes] = await Promise.all([listInstantVoices(owner), listVoiceChanges(owner)]);
    return json({ voices: voices.map(publicInstantVoice), changes: changes.map(publicVoiceChange), available: voiceChangerAvailable() });
  } catch (err) {
    return errorResponse(err);
  }
}
