"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ShareBody } from "@/lib/share-body";
import { SHARE_PLAYER_ID } from "@/lib/share-player";
import { watermarkPlace } from "@/lib/watermark";
import { ShareCta } from "./ShareCta";
import { SharePlayer } from "./SharePlayer";
import { ShareTranscript } from "./ShareTranscript";
import { ShareChapters } from "./ShareChapters";
import { ShareKeys } from "./ShareKeys";
import { ShareMoment } from "./ShareMoment";
import { ShareResume } from "./ShareResume";
import { ShareSpeed } from "./ShareSpeed";
import { ViewBeacon } from "./ViewBeacon";
import { useMiniPlayer } from "@/hooks/useMiniPlayer";

/** A share page's player, button, download link, description, and transcript, from what the server let this viewer see. */
export function ShareWatch({ body, autoplay, loop, start, end, focus = false, embed = false }: { body: ShareBody; autoplay: boolean; loop: boolean; start?: number; end?: number; focus?: boolean; embed?: boolean }) {
  // Shown in place of the email form, it takes the focus the form's button had, rather than leaving it on the page.
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) frameRef.current?.focus();
  }, [focus]);
  // Embedded, the player is all there is: the largest box of the video's shape that fits the frame it was given, centred
  // in it (after the email form too), so the logo and captions sit on the picture rather than in black bars.
  const frame = embed ? "fixed inset-0 m-auto" : body.aspect === "9:16" ? "aspect-[9/16] max-w-[420px]" : body.aspect === "1:1" ? "aspect-square max-w-[640px]" : body.aspect === "4:5" ? "aspect-[4/5] max-w-[540px]" : body.aspect === "5:4" ? "aspect-[5/4] max-w-[800px]" : "aspect-video";
  const ratio = body.aspect === "9:16" ? 9 / 16 : body.aspect === "1:1" ? 1 : body.aspect === "4:5" ? 4 / 5 : body.aspect === "5:4" ? 5 / 4 : 16 / 9;
  const embedBox = embed ? { width: `min(100vw, ${+(ratio * 100).toFixed(4)}vh)`, height: `min(100vh, ${+(100 / ratio).toFixed(4)}vw)` } : undefined;
  const { player, cta } = body;
  // A made video (one with a player) can be linked at the moment a viewer is watching.
  const moment = !!player;
  // On the page (not in an embed, which is only the player), a playing video follows the viewer down as a mini player.
  const slotRef = useRef<HTMLDivElement>(null);
  const { mini, close, back } = useMiniPlayer(slotRef, SHARE_PLAYER_ID, !embed && !!player);
  const aspect = frame.split(" ").find((c) => c.startsWith("aspect-")) ?? "aspect-video";
  // Small enough to leave the page readable: an upright or square video narrower, and never taller than half the screen.
  const upright = ratio <= 1;
  const miniWidth = `min(${upright ? "220px, 45vw" : "360px, calc(100vw - 2rem)"}, calc((100dvh - 2rem) * ${+ratio.toFixed(4)} * 0.5))`;
  // The buttons go when the mini player does (closed, back in its place): if the keyboard was on one, it moves to the video.
  const miniButtons = useRef<HTMLDivElement>(null);
  const focusOnMini = useRef(false);
  useLayoutEffect(() => {
    if (mini || !focusOnMini.current) return;
    focusOnMini.current = false;
    if (document.activeElement === document.body || !document.activeElement) {
      (document.getElementById(SHARE_PLAYER_ID) as HTMLVideoElement | null)?.focus({ preventScroll: true });
    }
  }, [mini]);
  return (
    <>
      {body.status === "completed" && <ViewBeacon videoId={body.videoId} />}
      {/* The player's place on the page, kept while the player itself is pinned small in a corner. */}
      <div ref={slotRef} style={embedBox} className={embed ? `${frame}` : `relative mx-auto w-full ${frame}`} data-testid="share-player-slot">
      <div
        ref={frameRef}
        tabIndex={focus ? -1 : undefined}
        role={focus ? "region" : undefined}
        aria-label={focus ? "Video" : undefined}
        style={mini ? { width: miniWidth } : undefined}
        className={`${embed ? "absolute inset-0" : mini ? `fixed bottom-4 right-4 z-40 ${aspect} rounded-lg shadow-2xl ring-1 ring-white/20` : "absolute inset-0 rounded-xl"} overflow-hidden bg-black focus:outline-none`}
        data-mini={mini ? "true" : undefined}
        data-testid="share-player-frame"
      >
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
            start={start}
            end={end}
            tracks={player.tracks}
            chapters={body.chapters}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-10 text-center text-sm text-slate-400">
            {body.status === "failed" ? "This video could not be rendered." : "This video is still rendering. Check back in a minute."}
          </div>
        )}
        {mini && (
          <div
            ref={miniButtons}
            role="group"
            aria-label="Mini player"
            className="absolute right-1 top-1 z-30 flex gap-1"
            onFocus={() => (focusOnMini.current = true)}
            onBlur={(e) => {
              if (!miniButtons.current?.contains(e.relatedTarget as Node | null)) focusOnMini.current = false;
            }}
          >
            <button type="button" onClick={back} aria-label="Back to the video" title="Back to the video" className="rounded bg-black/70 px-2 py-0.5 text-xs text-white hover:bg-black">
              ↑
            </button>
            <button type="button" onClick={close} aria-label="Close the mini player" title="Close (pauses the video)" className="rounded bg-black/70 px-2 py-0.5 text-xs text-white hover:bg-black">
              ✕
            </button>
          </div>
        )}
      </div>
      </div>
      {/* On a plain link only: one that starts at a time or plays a section says where to watch already. */}
      {!embed && !autoplay && player && start === undefined && end === undefined && <ShareResume playerId={SHARE_PLAYER_ID} videoId={body.videoId} />}
      {!embed && (cta || body.download || moment) && (
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
          {moment && <ShareSpeed playerId={SHARE_PLAYER_ID} />}
          {moment && <ShareMoment playerId={SHARE_PLAYER_ID} shareUrl={body.shareUrl} />}
        </p>
      )}
      {/* The player's keyboard shortcuts, in an embed's frame too; the list of them only on the page. */}
      {player && <ShareKeys playerId={SHARE_PLAYER_ID} list={!embed} burnedIn={player.captions && !player.trackDefault} />}
      {!embed && body.description && (
        <p className="mt-6 whitespace-pre-wrap text-base leading-relaxed text-slate-100" data-testid="share-description">
          {body.description}
        </p>
      )}
      {!embed && body.chapters && body.chapters.length > 1 && <ShareChapters playerId={SHARE_PLAYER_ID} chapters={body.chapters} />}
      {/* Once there is a video, the script is its transcript: the caption lines (corrected ones when an editor saved them), each playing from its time. */}
      {embed ? null : body.transcripts ? (
        <ShareTranscript playerId={SHARE_PLAYER_ID} transcripts={body.transcripts} title={body.title} />
      ) : body.script ? (
        <p className="mt-6 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{body.script}</p>
      ) : null}
      {/* Room at the foot of the page for the mini player, so nothing stays hidden under it once scrolled to the end. */}
      {mini && <div aria-hidden className="pointer-events-none" style={{ height: `calc(${miniWidth} / ${+ratio.toFixed(4)} + 2rem)` }} data-testid="share-mini-room" />}
    </>
  );
}
