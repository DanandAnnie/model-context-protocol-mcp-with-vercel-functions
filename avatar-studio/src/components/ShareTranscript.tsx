"use client";
import { useEffect, useRef, useState } from "react";
import { shareTrackId } from "@/lib/share-player";
import { formatTimestamp } from "@/lib/text";

type Cue = { startMs: number; endMs: number; text: string };

/**
 * The share page's transcript: the caption lines with their times. A line plays the video from there,
 * and the line being spoken is marked as the video plays (scrolled into view inside the list only, so
 * the page itself never jumps). It follows the subtitle track the viewer picks in the player: a
 * translated track shows that language's lines, anything else the script's.
 */
export function ShareTranscript({ playerId, transcripts }: { playerId: string; transcripts: Array<{ language?: string; code?: string; cues: Cue[] }> }) {
  const [which, setWhich] = useState(0);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLOListElement>(null);
  const shown = transcripts[which] ?? transcripts[0];
  const cues = shown.cues;

  useEffect(() => {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    // Translated tracks carry an id made from their language (a label could be anything, even "Captions");
    // the script's own track, or none, means the script. Only a track of words counts: the chapters track is
    // "showing" too in some browsers, which draw nothing for it.
    const follow = () => {
      const showing = Array.from(el.textTracks).find((t) => t.mode === "showing" && (t.kind === "subtitles" || t.kind === "captions"));
      const i = showing?.id ? transcripts.findIndex((t) => t.language && shareTrackId(t.language) === showing.id) : -1;
      setWhich(i > 0 ? i : 0);
    };
    follow();
    el.textTracks.addEventListener("change", follow);
    return () => el.textTracks.removeEventListener("change", follow);
  }, [playerId, transcripts]);

  useEffect(() => {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    const sync = () => {
      // Whole milliseconds: a seek to startMs / 1000 can read back a hair earlier, which would mark the line before.
      const ms = Math.round(el.currentTime * 1000);
      // The last line that has started, unless it has ended too (a pause, or after the last line): then none.
      let i = -1;
      while (i + 1 < cues.length && cues[i + 1].startMs <= ms) i++;
      setActive(i >= 0 && ms < cues[i].endMs ? i : -1);
    };
    // Right away too: switching language mid-video marks the new language's line without waiting for playback.
    sync();
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
  }, [active, cues]);

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
        Transcript{shown.language ? ` · ${shown.language}` : ""}
      </h2>
      <ol ref={list} lang={shown.language ? (shown.code ?? "und") : undefined} className="relative max-h-80 space-y-0.5 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/60 p-2" data-testid="share-transcript">
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
