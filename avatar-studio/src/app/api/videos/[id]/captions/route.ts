import { cookies } from "next/headers";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { buildCues, cuesToSrt, cuesToVtt } from "@/lib/captions";
import { LOCAL_OWNER, optionalOwner, requireEditor } from "@/lib/owner";
import { shareCookieName, shareGateCookieName, shareGatePassed, shareUnlocked } from "@/lib/share-lock";
import { NotFoundError, PUBLIC_ACCESS, captionCuesFor, captionCuesSchema, captionDurationSec, getVideo, resetCaptionCues, saveCaptionCues, subtitlesFor } from "@/lib/services";
import type { Video } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Subtitles: the corrected captions when an editor saved some, else lines derived from the script, timed to the
 * rendered duration. `?format=vtt` for WebVTT, `?format=json` for `{ cues, edited }`, SRT otherwise; `?lang=`
 * serves a translated track the video carries.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const params = new URL(req.url).searchParams;
    const format = params.get("format");
    const vtt = format === "vtt";
    const lang = params.get("lang");
    // Captions are derived from the script, which an open share page already shows. When the
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
    // A password-protected share link hands its captions only to visitors who entered the password, and a link that
    // asks for an email only to visitors who gave one (the transcript is what the gate holds back); the owner always.
    if ((video.shareLocked || video.shareGate) && !isOwner) {
      const owner = await optionalOwner();
      isOwner = !!owner && (video.ownerId ?? LOCAL_OWNER) === owner;
      const jar = await cookies();
      if (!isOwner && !(await shareUnlocked(video, jar.get(shareCookieName(id))?.value))) {
        return json({ error: "Password required" }, { status: 401 });
      }
      if (!isOwner && !shareGatePassed(video, jar.get(shareGateCookieName(id))?.value)) {
        return json({ error: "Enter your email on the share page to get the captions" }, { status: 401 });
      }
    }
    // A translated track, when asked for; the timing still follows the original script's length.
    const track = lang ? subtitlesFor(video, lang) : undefined;
    if (lang && !track) throw new NotFoundError(`No ${lang} subtitles on this video`);
    const { cues, edited } = track ? { cues: buildCues(track.text, captionDurationSec(video)), edited: false } : captionCuesFor(video);
    if (format === "json") return json({ cues: cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), edited }, { headers: { "Cache-Control": "no-store" } });
    const body = vtt ? cuesToVtt(cues, video.captionStyle?.position) : cuesToSrt(cues);
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

/** Saves corrected captions in the script's language: `{ cues: [{ startMs, endMs, text }] }`, in order and not overlapping. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const input = captionCuesSchema.parse(await readJson(req));
    return json({ video: await saveCaptionCues((await ctx.params).id, input, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Drops the corrections so the captions follow the script again. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    return json({ video: await resetCaptionCues((await ctx.params).id, owner) });
  } catch (err) {
    return errorResponse(err);
  }
}
