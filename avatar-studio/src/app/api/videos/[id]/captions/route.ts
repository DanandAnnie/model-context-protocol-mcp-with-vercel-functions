import { errorResponse } from "@/lib/api-utils";
import { buildSrt } from "@/lib/captions";
import { getVideo } from "@/lib/services";

export const dynamic = "force-dynamic";

/** SRT subtitles derived from the script, timed to the rendered duration. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const video = await getVideo(id, false);
    // Fall back to a reading-speed estimate when the provider did not report a duration.
    const words = video.script.trim().split(/\s+/).filter(Boolean).length;
    const duration = video.durationSec ?? Math.max(1, Math.round(words / 2.5 / video.speed));
    const srt = buildSrt(video.script, duration);
    const filename = `${video.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "captions"}.srt`;
    return new Response(srt, {
      headers: {
        "Content-Type": "application/x-subrip; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
