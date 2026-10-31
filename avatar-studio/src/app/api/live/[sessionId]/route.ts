import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { closeLiveSession, keepLiveSession, liveSessionCall, speakLive } from "@/lib/streaming";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ sessionId: string }> };

/**
 * Make the live presenter say a reply (`spoken: false` when the browser says it in the room, as with LiveAvatar), or,
 * with `{ keepAlive: true }`, keep a session the page still shows from ending as idle.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const owner = await requireEditor();
    const body = liveSessionCall.parse(await readJson(req));
    const { sessionId } = await ctx.params;
    if ("keepAlive" in body) {
      await keepLiveSession(sessionId, `owner:${owner}`);
      return json({ ok: true });
    }
    return json({ ok: true, ...(await speakLive(sessionId, `owner:${owner}`, body.text)) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const owner = await requireEditor();
    await closeLiveSession((await ctx.params).sessionId, `owner:${owner}`);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
