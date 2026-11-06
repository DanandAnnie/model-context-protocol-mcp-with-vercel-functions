"use client";
import { useEffect, useRef, useState } from "react";
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
  end,
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
  /**
   * Seconds to stop at (a share link's `?end=`), so the link plays a section: playback crossing it pauses there and the
   * player says the section is over, with Keep watching and Watch it again; looping, the section repeats instead.
   */
  end?: number;
  /** Translated subtitle tracks the video carries, offered in the CC menu. */
  tracks?: Array<{ language: string; code?: string }>;
  /** Where each chapter starts and the scene it opens, in order. */
  chapters?: Array<{ startMs: number; scene: number }>;
}) {
  const reported = useRef<WatchQuarter | 0>(0);
  /** Where the section stops, until the viewer chooses to keep watching past it. */
  const [stopAt, setStopAt] = useState(end);
  const [sectionOver, setSectionOver] = useState(false);
  /** The playhead at the last time update (paused or not); a seek clears it, so only playing across the end stops there. */
  const lastPlayed = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
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
  /** Stops at the section's end when playback crosses it (a seek past it, then play, plays on). */
  const holdSection = (el: HTMLVideoElement) => {
    const before = lastPlayed.current;
    lastPlayed.current = el.currentTime;
    if (stopAt === undefined || el.paused || before === null || before >= stopAt || el.currentTime < stopAt) return;
    // Seeking (back to the start, or to the end itself) clears the mark, through onSeeking.
    if (loop) {
      el.currentTime = start ?? 0;
      return;
    }
    el.pause();
    // Played a moment past the end before this update came; the player is put back on it.
    el.currentTime = stopAt;
    setSectionOver(true);
    // Fullscreen shows the picture alone, without the note and its buttons, so the player leaves it.
    if (typeof document !== "undefined" && document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
    const webkit = el as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean; webkitExitFullscreen?: () => void };
    if (webkit.webkitDisplayingFullscreen) webkit.webkitExitFullscreen?.();
  };
  return (
    <>
    <video
      ref={videoRef}
      src={src}
      poster={poster}
      controls
      autoPlay={autoplay}
      muted={autoplay}
      // A section loops itself (from its start); the native loop would restart the whole video at its end.
      loop={loop && stopAt === undefined}
      playsInline
      id={SHARE_PLAYER_ID}
      className={`h-full w-full cue-${captionSize} cue-look-${captionLook} cue-font-${captionFont}`}
      data-testid="share-player"
      onTimeUpdate={(e) => {
        const el = e.currentTarget;
        holdSection(el);
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
        lastPlayed.current = null;
      }}
      onPlay={() => setSectionOver(false)}
      onEnded={(e) => {
        report(100);
        // A section that runs to the video's own end loops from the section's start.
        if (loop && stopAt !== undefined) {
          const el = e.currentTarget;
          el.currentTime = start ?? 0;
          void el.play().catch(() => undefined);
        }
      }}
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
    {/* Kept in the page from the start, so the announcement is heard when the section ends. */}
    {end !== undefined && (
      <p role="status" className="sr-only">
        {sectionOver ? "End of the shared section. Watch it again, or keep watching." : ""}
      </p>
    )}
    {sectionOver && (
      <div className="absolute inset-x-0 bottom-16 z-20 mx-auto flex w-fit max-w-[90%] flex-wrap items-center justify-center gap-2 rounded-lg bg-black/80 px-3 py-2 text-sm text-white" data-testid="share-section-over">
        <span>End of the shared section.</span>
        <button
          type="button"
          className="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-slate-900 hover:bg-slate-200"
          onClick={() => {
            const el = videoRef.current;
            if (!el) return;
            el.currentTime = start ?? 0;
            void el.play().catch(() => undefined);
          }}
        >
          Watch it again
        </button>
        <button
          type="button"
          className="rounded-md border border-white/60 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/10"
          onClick={() => {
            setStopAt(undefined);
            setSectionOver(false);
            void videoRef.current?.play().catch(() => undefined);
          }}
        >
          Keep watching
        </button>
      </div>
    )}
    </>
  );
}
