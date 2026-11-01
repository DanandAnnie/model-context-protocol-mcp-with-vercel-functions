import { errorResponse, json, readJson } from "@/lib/api-utils";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { rateReply, rateSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Public: a visitor rates one of the presenter's replies in their conversation (`rating: null` takes it back). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const gate = rateLimit(`talk-rate:${clientIp(req)}`, 60, 10 * 60 * 1000);
    if (!gate.allowed) return json({ error: "Too many ratings; try again later" }, { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } });
    await rateReply(id, rateSchema.parse(await readJson(req)));
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
