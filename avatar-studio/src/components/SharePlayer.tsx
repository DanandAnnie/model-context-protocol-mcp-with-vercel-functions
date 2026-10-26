"use client";
import { useRef } from "react";
import { SHARE_PLAYER_ID, shareTrackId } from "@/lib/share-player";
import type { CaptionLook, CaptionSize, WatchQuarter } from "@/lib/types";

/**
 * The share page's player. Reports the furthest point the viewer reaches (a quarter, half,
 * three quarters, the end), once per marker per mount and one request at a time: the server
 * counts every marker up to the one reported, so a seek past three markers is one beacon.
 */
export function SharePlayer({
  videoId,
  src,
  poster,
  captions,
  captionSize = "medium",
  captionLook = "classic",
  trackDefault = true,
  autoplay = false,
  loop = false,
  tracks = [],
}: {
  videoId: string;
  src: string;
  poster?: string;
  captions: boolean;
  captionSize?: CaptionSize;
  captionLook?: CaptionLook;
  trackDefault?: boolean;
  /** Start muted on load (browsers allow muted autoplay only); used by embeds. */
  autoplay?: boolean;
  loop?: boolean;
  /** Translated subtitle tracks the video carries, offered in the CC menu. */
  tracks?: Array<{ language: string; code?: string }>;
}) {
  const reported = useRef<WatchQuarter | 0>(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const report = (quarter: WatchQuarter) => {
    if (quarter <= reported.current) return;
    reported.current = quarter;
    queue.current = queue.current
      .then(() => fetch(`/api/videos/${videoId}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quarter }), keepalive: true }))
      .then(() => undefined, () => undefined);
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
      className={`h-full w-full cue-${captionSize} cue-look-${captionLook}`}
      data-testid="share-player"
      onTimeUpdate={(e) => {
        const el = e.currentTarget;
        if (!Number.isFinite(el.duration) || el.duration <= 0) return;
        const pct = (el.currentTime / el.duration) * 100;
        // A looping video never ends, so the last half second counts as the end.
        const reached = loop && el.duration - el.currentTime < 0.5 ? 100 : pct >= 75 ? 75 : pct >= 50 ? 50 : pct >= 25 ? 25 : 0;
        if (reached) report(reached);
      }}
      onEnded={() => report(100)}
    >
      {/* `default` switches the track on without a trip to the CC menu; it stays off when the file already carries captions. */}
      {captions && <track default={trackDefault} kind="subtitles" srcLang="en" label="Captions" src={`/api/videos/${videoId}/captions?format=vtt`} />}
      {tracks.map((t) => (
        <track key={t.language} id={shareTrackId(t.language)} kind="subtitles" srcLang={t.code ?? "und"} label={t.language} src={`/api/videos/${videoId}/captions?format=vtt&lang=${encodeURIComponent(t.language)}`} />
      ))}
    </video>
  );
}
