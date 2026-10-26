"use client";
import { useEffect, useRef } from "react";
import type { ShareBody } from "@/lib/share-body";
import { SHARE_PLAYER_ID } from "@/lib/share-player";
import { watermarkPlace } from "@/lib/watermark";
import { ShareCta } from "./ShareCta";
import { SharePlayer } from "./SharePlayer";
import { ShareTranscript } from "./ShareTranscript";
import { ShareChapters } from "./ShareChapters";
import { ViewBeacon } from "./ViewBeacon";

/** A share page's player, button, download link, description, and transcript, from what the server let this viewer see. */
export function ShareWatch({ body, autoplay, loop, focus = false, embed = false }: { body: ShareBody; autoplay: boolean; loop: boolean; focus?: boolean; embed?: boolean }) {
  // Shown in place of the email form, it takes the focus the form's button had, rather than leaving it on the page.
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) frameRef.current?.focus();
  }, [focus]);
  // Embedded, the player is all there is: it fills the frame it was given, its shape kept inside it.
  const frame = embed ? "h-full" : body.aspect === "9:16" ? "aspect-[9/16] max-w-[420px]" : body.aspect === "1:1" ? "aspect-square max-w-[640px]" : "aspect-video";
  const { player, cta } = body;
  return (
    <>
      {body.status === "completed" && <ViewBeacon videoId={body.videoId} />}
      <div ref={frameRef} tabIndex={focus ? -1 : undefined} role={focus ? "region" : undefined} aria-label={focus ? "Video" : undefined} className={`relative mx-auto w-full overflow-hidden bg-black focus:outline-none ${embed ? "" : "rounded-xl"} ${frame}`}>
        {body.watermark && (
          // The logo belongs to the page, not the video file, so it is not shown when the player goes fullscreen
          // or picture-in-picture; decorative (the header names the brand), and clicks pass through to the player.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={body.watermark.src}
            alt=""
            aria-hidden
            className={`pointer-events-none absolute z-10 h-[9%] max-h-12 w-[18%] object-contain opacity-80 drop-shadow ${watermarkPlace(body.watermark.corner, !!player?.captions)}`}
            data-testid="share-watermark"
            data-corner={body.watermark.corner}
          />
        )}
        {player ? (
          <SharePlayer
            videoId={body.videoId}
            src={player.src}
            poster={player.poster}
            captions={player.captions}
            captionSize={player.captionStyle?.size}
            captionLook={player.captionStyle?.look}
            captionFont={player.captionStyle?.font}
            trackDefault={player.trackDefault}
            autoplay={autoplay}
            loop={loop}
            tracks={player.tracks}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-10 text-center text-sm text-slate-400">
            {body.status === "failed" ? "This video could not be rendered." : "This video is still rendering. Check back in a minute."}
          </div>
        )}
      </div>
      {!embed && (cta || body.download) && (
        <p className="mt-4 flex flex-wrap items-center gap-3">
          {cta && <ShareCta videoId={body.videoId} label={cta.label} url={cta.url} background={cta.background} dark={cta.dark} />}
          {body.download && (
            <a
              href={body.download}
              download
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700"
            >
              Download video
            </a>
          )}
        </p>
      )}
      {!embed && body.description && (
        <p className="mt-6 whitespace-pre-wrap text-base leading-relaxed text-slate-100" data-testid="share-description">
          {body.description}
        </p>
      )}
      {!embed && body.chapters && body.chapters.length > 1 && <ShareChapters playerId={SHARE_PLAYER_ID} chapters={body.chapters} />}
      {/* Once there is a video, the script is its transcript: the caption lines (corrected ones when an editor saved them), each playing from its time. */}
      {embed ? null : body.transcripts ? (
        <ShareTranscript playerId={SHARE_PLAYER_ID} transcripts={body.transcripts} />
      ) : (
        <p className="mt-6 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{body.script}</p>
      )}
    </>
  );
}
