"use client";
import { useEffect, useRef } from "react";
import { chaptersPlayed, type PlayMark } from "@/lib/chapter-play";
import { SHARE_PLAYER_ID, shareTrackId } from "@/lib/share-player";
import { wellFormed } from "@/lib/text";
import type { CaptionFont, CaptionLook, CaptionSize, WatchQuarter } from "@/lib/types";

/**
 * The share page's player. Reports the furthest point the viewer reaches (a quarter, half,
 * three quarters, the end), once per marker per mount and one request at a time: the server
 * counts every marker up to the one reported, so a seek past three markers is one beacon.
 * It reports too each chapter the viewer plays, once per chapter per mount, through the same queue
 * (see `chaptersPlayed`): one only scrubbed through or landed on while paused does not count, and a
 * muted autoplay (an embed's background loop) counts none until the viewer turns the sound on.
 */
export function SharePlayer({
  videoId,
  src,
  poster,
  captions,
  captionSize = "medium",
  captionLook = "classic",
  captionFont = "sans",
  trackDefault = true,
  autoplay = false,
  loop = false,
  start,
  tracks = [],
  chapters = [],
}: {
  videoId: string;
  src: string;
  poster?: string;
  captions: boolean;
  captionSize?: CaptionSize;
  captionLook?: CaptionLook;
  captionFont?: CaptionFont;
  trackDefault?: boolean;
  /** Start muted on load (browsers allow muted autoplay only); used by embeds. */
  autoplay?: boolean;
  loop?: boolean;
  /** Seconds to start at (a share link's `?t=`), once the clip's length is known; ignored past its end. */
  start?: number;
  /** Translated subtitle tracks the video carries, offered in the CC menu. */
  tracks?: Array<{ language: string; code?: string }>;
  /** Where each chapter starts and the scene it opens, in order. */
  chapters?: Array<{ startMs: number; scene: number }>;
}) {
  const reported = useRef<WatchQuarter | 0>(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const played = useRef(new Set<number>());
  const started = useRef(false);
  // Once: a later metadata load (a source refreshed) must not pull the viewer back to the link's time.
  // Applied once the clip's length is known (a streamed file may report it only after its metadata).
  const startAt = (el: HTMLVideoElement) => {
    if (!start || started.current || !(el.readyState >= 1) || !Number.isFinite(el.duration) || el.duration <= 0) return;
    started.current = true;
    if (start < el.duration - 0.5) el.currentTime = start;
  };
  // The server-rendered player may have its metadata before this script runs, and so before the handler is there.
  useEffect(() => {
    const el = document.getElementById(SHARE_PLAYER_ID) as HTMLVideoElement | null;
    if (el) startAt(el);
    // Only on mount; later loads come through the handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The chapter and time of the last time update while playing, cleared by a seek.
  const last = useRef<PlayMark>(null);
  const send = (body: { quarter: WatchQuarter } | { scene: number }) => {
    queue.current = queue.current
      .then(() => fetch(`/api/videos/${videoId}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }))
      .then(() => undefined, () => undefined);
  };
  const report = (quarter: WatchQuarter) => {
    if (quarter <= reported.current) return;
    reported.current = quarter;
    send({ quarter });
  };
  const reportChapter = (el: HTMLVideoElement) => {
    if (el.paused || (autoplay && el.muted)) {
      last.current = null;
      return;
    }
    const clipMs = Number.isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 : Infinity;
    const { mark, played: now } = chaptersPlayed(chapters, clipMs, last.current, Math.round(el.currentTime * 1000));
    last.current = mark;
    for (const scene of now) {
      if (played.current.has(scene)) continue;
      played.current.add(scene);
      send({ scene });
    }
  };
  return (
    <video
      src={src}
      poster={poster}
      controls
      autoPlay={autoplay}
      muted={autoplay}
      loop={loop}
      playsInline
      id={SHARE_PLAYER_ID}
      className={`h-full w-full cue-${captionSize} cue-look-${captionLook} cue-font-${captionFont}`}
      data-testid="share-player"
      onTimeUpdate={(e) => {
        const el = e.currentTarget;
        reportChapter(el);
        // Only playback reaches a point: a link's start time, or a seek while paused, moves the playhead without it.
        if (el.paused || !Number.isFinite(el.duration) || el.duration <= 0) return;
        const pct = (el.currentTime / el.duration) * 100;
        // A looping video never ends, so the last half second counts as the end.
        const reached = loop && el.duration - el.currentTime < 0.5 ? 100 : pct >= 75 ? 75 : pct >= 50 ? 50 : pct >= 25 ? 25 : 0;
        if (reached) report(reached);
      }}
      onLoadedMetadata={(e) => startAt(e.currentTarget)}
      onDurationChange={(e) => startAt(e.currentTarget)}
      onSeeking={() => {
        last.current = null;
      }}
      onEnded={() => report(100)}
    >
      {/* `default` switches the track on without a trip to the CC menu; it stays off when the file already carries captions. */}
      {captions && <track default={trackDefault} kind="subtitles" srcLang="en" label="Captions" src={`/api/videos/${videoId}/captions?format=vtt`} />}
      {/* The chapters as the player's chapters track, for players and scripts that read one; the page's own list is below.
          `default` is what loads it (a chapters track is otherwise left disabled and never fetched). Browsers draw
          nothing for it, and the transcript follows only tracks of words, so it leaves both alone. */}
      {chapters.length >= 2 && <track default kind="chapters" srcLang="en" label="Chapters" src={`/api/videos/${videoId}/captions?format=chapters`} />}
      {tracks.map((t) => (
        <track key={t.language} id={shareTrackId(t.language)} kind="subtitles" srcLang={t.code ?? "und"} label={t.language} src={`/api/videos/${videoId}/captions?format=vtt&lang=${encodeURIComponent(wellFormed(t.language))}`} />
      ))}
    </video>
  );
}
