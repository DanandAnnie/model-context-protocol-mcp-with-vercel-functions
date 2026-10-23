import { errorResponse, json, readJson } from "@/lib/api-utils";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { publicAgent, talkSchema, talkToAgent } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

/** Public: who the visitor is talking to (no instructions, no owner). */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    return json({ agent: await publicAgent((await ctx.params).id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Public: one visitor turn. Limited per client and per agent, since each turn can cost an LLM call. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ip = clientIp(req);
    const perClient = rateLimit(`talk:${ip}`, 30, 10 * 60 * 1000);
    const perAgent = rateLimit(`talk-agent:${id}`, 600, 60 * 60 * 1000);
    const gate = !perClient.allowed ? perClient : !perAgent.allowed ? perAgent : null;
    if (gate) return json({ error: "This presenter is busy; try again in a few minutes" }, { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } });
    const input = talkSchema.parse(await readJson(req));
    return json(await talkToAgent(id, input));
  } catch (err) {
    return errorResponse(err);
  }
}
