"use client";
import { useEffect, useState } from "react";
import { formatTimestamp } from "@/lib/text";
import type { Chapter } from "@/lib/chapters";

/**
 * The share page's chapters: one per scene, each playing the video from where its scene starts, the one playing
 * marked as the video plays.
 */
export function ShareChapters({ playerId, chapters }: { playerId: string; chapters: Chapter[] }) {
  const [active, setActive] = useState(0);

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

  return (
    <section className="mt-6" aria-labelledby="share-chapters-title">
      <h2 id="share-chapters-title" className="mb-2 text-sm font-semibold text-slate-200">
        Chapters
      </h2>
      <ol className="grid gap-1 sm:grid-cols-2" data-testid="share-chapters">
        {chapters.map((c, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => playFrom(c.startMs)}
              aria-current={i === active ? "true" : undefined}
              className={`flex w-full gap-3 rounded-md border px-3 py-2 text-left text-sm ${i === active ? "border-slate-600 bg-slate-800 text-white" : "border-slate-800 text-slate-300 hover:bg-slate-800/60"}`}
            >
              <span className="w-12 shrink-0 font-mono text-xs leading-5 text-slate-400">{formatTimestamp(c.startMs / 1000)}</span>
              <span className="min-w-0 truncate">{c.title}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
