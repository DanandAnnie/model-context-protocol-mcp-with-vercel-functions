"use client";
import { useRef } from "react";
import type { WatchQuarter } from "@/lib/types";

/**
 * The share page's player. Reports the furthest point the viewer reaches (a quarter, half,
 * three quarters, the end), once per marker per mount and one request at a time: the server
 * counts every marker up to the one reported, so a seek past three markers is one beacon.
 */
export function SharePlayer({ videoId, src, poster, captions }: { videoId: string; src: string; poster?: string; captions: boolean }) {
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
      autoPlay={false}
      playsInline
      className="h-full w-full"
      data-testid="share-player"
      onTimeUpdate={(e) => {
        const el = e.currentTarget;
        if (!Number.isFinite(el.duration) || el.duration <= 0) return;
        const pct = (el.currentTime / el.duration) * 100;
        const reached = pct >= 75 ? 75 : pct >= 50 ? 50 : pct >= 25 ? 25 : 0;
        if (reached) report(reached);
      }}
      onEnded={() => report(100)}
    >
      {captions && <track kind="subtitles" srcLang="en" label="Captions" src={`/api/videos/${videoId}/captions?format=vtt`} />}
    </video>
  );
}
