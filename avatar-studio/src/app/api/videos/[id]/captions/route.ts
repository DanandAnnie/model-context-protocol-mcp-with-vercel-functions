import { errorResponse } from "@/lib/api-utils";
import { buildSrt, buildVtt } from "@/lib/captions";
import { PUBLIC_ACCESS, getVideo } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Subtitles derived from the script, timed to the rendered duration. `?format=vtt` for WebVTT, SRT otherwise. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const vtt = new URL(req.url).searchParams.get("format") === "vtt";
    // Captions are derived from the script, which the public share page already shows.
    const video = await getVideo(id, PUBLIC_ACCESS, false);
    // Fall back to a reading-speed estimate when the provider did not report a duration.
    const words = video.script.trim().split(/\s+/).filter(Boolean).length;
    const duration = video.durationSec ?? Math.max(1, Math.round(words / 2.5 / video.speed));
    const body = vtt ? buildVtt(video.script, duration) : buildSrt(video.script, duration);
    const filename = `${video.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "captions"}.${vtt ? "vtt" : "srt"}`;
    return new Response(body, {
      headers: {
        "Content-Type": vtt ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
