import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { rateLimitPair } from "@/lib/rate-limit";
import { generatePortraitSchema, startPortrait } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Presenters an account may have drawn per hour, and every account together: each one is paid for with the renderer.
 * Counted per server instance, as the other limits are.
 */
const PER_OWNER = 10;
const PER_INSTANCE = 40;
const WINDOW_MS = 60 * 60 * 1000;

/** Start a portrait of a presenter drawn from a description; follow it with GET /api/avatars/generate/:jobId. */
export async function POST(req: Request) {
  try {
    const owner = await requireEditor();
    const input = generatePortraitSchema.parse(await readJson(req));
    const limit = rateLimitPair(`portrait:${owner}`, PER_OWNER, "portrait:*", PER_INSTANCE, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many presenters drawn for now; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    return json(await startPortrait(input, owner), { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
