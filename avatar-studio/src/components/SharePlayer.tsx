"use client";
import { useRef } from "react";
import type { WatchQuarter } from "@/lib/types";

/**
 * The share page's player. Reports how far the viewer gets (a quarter, half, three quarters,
 * the end) once each per mount; repeats within the server's window are not counted anyway.
 */
export function SharePlayer({ videoId, src, poster, captions }: { videoId: string; src: string; poster?: string; captions: boolean }) {
  const sent = useRef<Set<WatchQuarter>>(new Set());
  const report = (quarter: WatchQuarter) => {
    if (sent.current.has(quarter)) return;
    sent.current.add(quarter);
    fetch(`/api/videos/${videoId}/watch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quarter }), keepalive: true }).catch(() => {});
  };
  return (
    <video
      src={src}
      poster={poster}
      controls
      autoPlay={false}
      className="h-full w-full"
      data-testid="share-player"
      onTimeUpdate={(e) => {
        const el = e.currentTarget;
        if (!Number.isFinite(el.duration) || el.duration <= 0) return;
        const pct = (el.currentTime / el.duration) * 100;
        for (const q of [25, 50, 75] as const) if (pct >= q) report(q);
      }}
      onEnded={() => report(100)}
    >
      {captions && <track kind="subtitles" srcLang="en" label="Captions" src={`/api/videos/${videoId}/captions?format=vtt`} />}
    </video>
  );
}
