"use client";
import { useEffect, useMemo, useState } from "react";
import { formatTimestamp } from "@/lib/text";
import { listedChapters, type Chapter } from "@/lib/chapters";

/**
 * The share page's chapters: one per scene, each playing the video from where its scene starts, the one playing
 * marked as the video plays.
 */
export function ShareChapters({ playerId, chapters: all }: { playerId: string; chapters: Chapter[] }) {
  const [active, setActive] = useState(0);
  // The clip's own length once the player knows it: a chapter timed from an estimate past its end is left out.
  const [clipMs, setClipMs] = useState<number | null>(null);
  const chapters = useMemo(() => (clipMs ? listedChapters(all, clipMs) : all), [all, clipMs]);

  useEffect(() => {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    const measure = () => setClipMs(Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 1000) : null);
    measure();
    el.addEventListener("loadedmetadata", measure);
    el.addEventListener("durationchange", measure);
    return () => {
      el.removeEventListener("loadedmetadata", measure);
      el.removeEventListener("durationchange", measure);
    };
  }, [playerId]);

  useEffect(() => {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    const sync = () => {
      // Whole milliseconds, as the transcript reads them, so a seek to a chapter's start marks that chapter.
      const ms = Math.round(el.currentTime * 1000);
      let i = 0;
      while (i + 1 < chapters.length && chapters[i + 1].startMs <= ms) i++;
      setActive(i);
    };
    sync();
    el.addEventListener("timeupdate", sync);
    el.addEventListener("seeked", sync);
    return () => {
      el.removeEventListener("timeupdate", sync);
      el.removeEventListener("seeked", sync);
    };
  }, [playerId, chapters]);

  function playFrom(startMs: number) {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    el.currentTime = startMs / 1000;
    // Autoplay rules may refuse; the viewer then presses play from the new position.
    el.play().catch(() => undefined);
  }

  // One chapter left is no list to jump through.
  if (chapters.length < 2) return null;
  return (
    <section className="mt-6" aria-labelledby="share-chapters-title">
      <h2 id="share-chapters-title" className="mb-2 text-sm font-semibold text-slate-200">
        Chapters
      </h2>
      {/* One column of rows that never grow past it on a phone, where a long title is cut with an ellipsis. */}
      <ol className="grid grid-cols-1 gap-1 sm:grid-cols-2" data-testid="share-chapters">
        {chapters.map((c, i) => (
          <li key={i} className="min-w-0">
            <button
              type="button"
              onClick={() => playFrom(c.startMs)}
              aria-current={i === active ? "true" : undefined}
              className={`flex w-full gap-3 rounded-md border px-3 py-2 text-left text-sm ${i === active ? "border-slate-600 bg-slate-800 text-white" : "border-slate-800 text-slate-300 hover:bg-slate-800/60"}`}
            >
              <span className="w-12 shrink-0 font-mono text-xs leading-5 text-slate-400">{formatTimestamp(c.startMs / 1000)}</span>
              <span className="min-w-0 truncate" title={c.title}>{c.title}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
