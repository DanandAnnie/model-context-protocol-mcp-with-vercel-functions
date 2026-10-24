import { z } from "zod";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { closeLiveSession, speakLive } from "@/lib/streaming";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ sessionId: string }> };

/** Make the live presenter say a reply. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const owner = await requireEditor();
    const { text } = z.object({ text: z.string().trim().min(1).max(1500) }).parse(await readJson(req));
    await speakLive((await ctx.params).sessionId, `owner:${owner}`, text);
    return json({ ok: true });
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
