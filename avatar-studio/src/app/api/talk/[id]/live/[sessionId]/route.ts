import { errorResponse, json, readJson } from "@/lib/api-utils";
import { closeLiveSession, keepLiveSession, liveSessionCall, speakLive } from "@/lib/streaming";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; sessionId: string }> };

/** Public: speak a reply through the visitor's live session (scoped to the presenter it was opened for). */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id, sessionId } = await ctx.params;
    const body = liveSessionCall.parse(await readJson(req));
    if ("keepAlive" in body) {
      await keepLiveSession(sessionId, id);
      return json({ ok: true });
    }
    return json({ ok: true, ...(await speakLive(sessionId, id, body.text)) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id, sessionId } = await ctx.params;
    await closeLiveSession(sessionId, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
