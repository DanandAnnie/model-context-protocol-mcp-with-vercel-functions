import { cookies } from "next/headers";
import { errorResponse, json } from "@/lib/api-utils";
import { buildSrt, buildVtt } from "@/lib/captions";
import { LOCAL_OWNER, optionalOwner } from "@/lib/owner";
import { shareCookieName, shareUnlocked } from "@/lib/share-lock";
import { NotFoundError, PUBLIC_ACCESS, getVideo, subtitlesFor } from "@/lib/services";
import type { Video } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Subtitles derived from the script, timed to the rendered duration. `?format=vtt` for WebVTT, SRT otherwise; `?lang=` serves a translated track the video carries. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const params = new URL(req.url).searchParams;
    const vtt = params.get("format") === "vtt";
    const lang = params.get("lang");
    // Captions are derived from the script, which the public share page already shows. When the
    // owner has switched the share link off, only the owner's own download still works.
    let video: Video;
    let isOwner = false;
    try {
      video = await getVideo(id, PUBLIC_ACCESS, false);
    } catch (err) {
      const owner = err instanceof NotFoundError ? await optionalOwner() : null;
      if (!owner) throw err;
      video = await getVideo(id, owner, false);
      isOwner = true;
    }
    // A password-protected share link hands its captions only to visitors who entered the password, and to the owner.
    if (video.shareLocked && !isOwner) {
      const owner = await optionalOwner();
      isOwner = !!owner && (video.ownerId ?? LOCAL_OWNER) === owner;
      if (!isOwner && !(await shareUnlocked(video, (await cookies()).get(shareCookieName(id))?.value))) {
        return json({ error: "Password required" }, { status: 401 });
      }
    }
    // A translated track, when asked for; the timing still follows the original script's length.
    const track = lang ? subtitlesFor(video, lang) : undefined;
    if (lang && !track) throw new NotFoundError(`No ${lang} subtitles on this video`);
    // Fall back to a reading-speed estimate when the provider did not report a duration.
    const words = video.script.trim().split(/\s+/).filter(Boolean).length;
    const duration = video.durationSec ?? Math.max(1, Math.round(words / 2.5 / video.speed));
    const text = track?.text ?? video.script;
    const body = vtt ? buildVtt(text, duration, video.captionStyle?.position) : buildSrt(text, duration);
    const suffix = track ? `.${track.language.replace(/[^\w-]+/g, "_").toLowerCase()}` : "";
    const filename = `${video.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "captions"}${suffix}.${vtt ? "vtt" : "srt"}`;
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
