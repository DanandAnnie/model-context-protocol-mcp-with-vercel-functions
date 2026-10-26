import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimit } from "@/lib/rate-limit";
import { portraitStatus } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Checks an account may make per hour: a portrait is followed every few seconds for a few minutes. */
const PER_OWNER = 300;
const WINDOW_MS = 60 * 60 * 1000;

/** Where a portrait stands; a finished one comes back as a data URL to save as a photo avatar. */
export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  try {
    const owner = await requireEditor();
    const limit = rateLimit(`portraitstatus:${owner}`, PER_OWNER, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many checks for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    const { jobId } = await ctx.params;
    // Only the account that started a portrait can follow it; anyone else's answers "not found".
    return json(await portraitStatus(jobId, owner));
  } catch (err) {
    return errorResponse(err);
  }
}
