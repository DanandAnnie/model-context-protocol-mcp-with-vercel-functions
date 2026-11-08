import { errorResponse } from "@/lib/api-utils";
import { cuesToSrt, cuesToVtt } from "@/lib/captions";
import { requireOwner } from "@/lib/owner";
import { voiceChangeCaptions } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Captions for text spoken in a voice, timed by when its words were said: SRT, or WebVTT with `?format=vtt`; a 404
 * for a recording without word timings (viewers too).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const vtt = new URL(req.url).searchParams.get("format") === "vtt";
    const { title, cues } = await voiceChangeCaptions(id, await requireOwner());
    const filename = `${title.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "captions"}.${vtt ? "vtt" : "srt"}`;
    return new Response(vtt ? cuesToVtt(cues) : cuesToSrt(cues), {
      headers: {
        "Content-Type": vtt ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
