"use client";
import { useEffect, useRef, useState } from "react";
import { formatTimestamp } from "@/lib/text";

/**
 * The share page's transcript: the caption lines with their times. A line plays the video from there,
 * and the line being spoken is marked as the video plays (scrolled into view inside the list only, so
 * the page itself never jumps).
 */
export function ShareTranscript({ playerId, cues }: { playerId: string; cues: Array<{ startMs: number; text: string }> }) {
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    const sync = () => {
      const ms = el.currentTime * 1000;
      // The last line that has started; before the first one starts, none.
      let i = -1;
      while (i + 1 < cues.length && cues[i + 1].startMs <= ms) i++;
      setActive(i);
    };
    el.addEventListener("timeupdate", sync);
    el.addEventListener("seeked", sync);
    return () => {
      el.removeEventListener("timeupdate", sync);
      el.removeEventListener("seeked", sync);
    };
  }, [playerId, cues]);

  useEffect(() => {
    const box = list.current;
    const line = box?.children[active] as HTMLElement | undefined;
    if (!box || !line) return;
    if (line.offsetTop < box.scrollTop || line.offsetTop + line.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = line.offsetTop - box.clientHeight / 3;
    }
  }, [active]);

  function playFrom(startMs: number) {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    el.currentTime = startMs / 1000;
    // Autoplay rules may refuse; the viewer then presses play from the new position.
    el.play().catch(() => undefined);
  }

  return (
    <section className="mt-6" aria-labelledby="share-transcript-title">
      <h2 id="share-transcript-title" className="mb-2 text-sm font-semibold text-slate-200">
        Transcript
      </h2>
      <ol ref={list} className="relative max-h-80 space-y-0.5 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/60 p-2" data-testid="share-transcript">
        {cues.map((cue, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => playFrom(cue.startMs)}
              aria-current={i === active ? "true" : undefined}
              className={`flex w-full gap-3 rounded-md px-2 py-1.5 text-left text-sm leading-relaxed ${i === active ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800/60"}`}
            >
              <span className="w-12 shrink-0 font-mono text-xs leading-6 text-slate-400">{formatTimestamp(cue.startMs / 1000)}</span>
              <span>{cue.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
