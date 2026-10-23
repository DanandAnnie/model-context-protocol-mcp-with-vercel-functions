import { z } from "zod";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { closeLiveSession, speakLive } from "@/lib/streaming";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; sessionId: string }> };

/** Public: speak a reply through the visitor's live session (scoped to the presenter it was opened for). */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id, sessionId } = await ctx.params;
    const { text } = z.object({ text: z.string().trim().min(1).max(1500) }).parse(await readJson(req));
    await speakLive(sessionId, id, text);
    return json({ ok: true });
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
