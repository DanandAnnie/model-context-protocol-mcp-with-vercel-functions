import { errorResponse, json, readJson } from "@/lib/api-utils";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { captureLead, leadSchema } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Public: a visitor leaves an email on their conversation. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const gate = rateLimit(`lead:${clientIp(req)}`, 5, 10 * 60 * 1000);
    if (!gate.allowed) return json({ error: "Too many submissions; try again later" }, { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } });
    await captureLead(id, leadSchema.parse(await readJson(req)));
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
