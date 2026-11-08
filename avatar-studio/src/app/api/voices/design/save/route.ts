import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { saveDesignedVoice, saveDesignedVoiceSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Saves an account may make per hour: each takes a voice slot with the provider. */
const PER_OWNER = 20;
const WINDOW_MS = 60 * 60 * 1000;

/** Keep one designed preview as a voice of the account. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = saveDesignedVoiceSchema.parse(await readJson(req));
    const limit = rateLimit(`voicedesignsave:${owner}`, PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many voices saved for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json({ voice: await saveDesignedVoice(input, owner) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
