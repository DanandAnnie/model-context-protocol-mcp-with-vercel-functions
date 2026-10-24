import { errorResponse, json } from "@/lib/api-utils";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { getStore } from "@/lib/store";
import { openLiveSession } from "@/lib/streaming";
import type { Agent } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Public: open a live video session with a shared presenter. `{ available: false }` when live video is off. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const agent = await getStore().get<Agent>("agent", id);
    if (!agent || !agent.isPublic) return json({ error: "This presenter is not available" }, { status: 404 });
    const ip = clientIp(req);
    const gate = rateLimit(`live:${ip}`, 6, 10 * 60 * 1000);
    if (!gate.allowed) return json({ error: "Too many live sessions; try again later" }, { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } });
    const session = await openLiveSession({ avatarId: agent.avatarId, voiceId: agent.voiceId, scope: agent.id, clientKey: `${agent.id}:${ip}` });
    return json(session ? { available: true, ...session } : { available: false });
  } catch (err) {
    return errorResponse(err);
  }
}
