"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { shareTrackId } from "@/lib/share-player";
import { formatTimestamp } from "@/lib/text";
import { TRANSCRIPT_QUERY_MAX, findInTranscript, markLine, matchesByLine, stepMatch } from "@/lib/transcript-search";
import { transcriptFileName, transcriptText } from "@/lib/share-transcript-file";

type Cue = { startMs: number; endMs: number; text: string };

/**
 * The share page's transcript: the caption lines with their times. A line plays the video from there,
 * and the line being spoken is marked as the video plays (scrolled into view inside the list only, so
 * the page itself never jumps). It follows the subtitle track the viewer picks in the player: a
 * translated track shows that language's lines, anything else the script's. A search box over it finds a word or
 * phrase in the lines shown (ignoring case and accents), marks each place, and steps through them. The lines shown can
 * be copied or saved as text, with their times or without, built here from what the page holds.
 */
export function ShareTranscript({ playerId, transcripts, title }: { playerId: string; transcripts: Array<{ language?: string; code?: string; cues: Cue[] }>; title: string }) {
  const [which, setWhich] = useState(0);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLOListElement>(null);
  const shown = transcripts[which] ?? transcripts[0];
  const cues = shown.cues;
  const [query, setQuery] = useState("");
  const [times, setTimes] = useState(true);
  const [saved, setSaved] = useState("");
  const [current, setCurrent] = useState(-1);
  const matches = useMemo(() => findInTranscript(cues.map((c) => c.text), query), [cues, query]);
  const byLine = useMemo(() => matchesByLine(matches), [matches]);
  // The match shown as current: kept inside the matches there are, for the moment between new matches and the reset.
  const at = current >= 0 && current < matches.length ? current : matches.length ? 0 : -1;
  // The list follows the line being spoken unless the viewer is moving through matches; playing follows again.
  const following = useRef(true);

  // A new search, or the lines changing language, starts at the first match, as a browser's find does; finding
  // nothing leaves the list following the video.
  useEffect(() => {
    setCurrent(matches.length ? 0 : -1);
    following.current = !matches.length;
  }, [matches]);

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
    // Playing (from the player, a key, or a line) means watching again: the list follows the spoken line.
    const onPlay = () => {
      following.current = true;
    };
    el.addEventListener("timeupdate", sync);
    el.addEventListener("seeked", sync);
    el.addEventListener("play", onPlay);
    return () => {
      el.removeEventListener("timeupdate", sync);
      el.removeEventListener("seeked", sync);
      el.removeEventListener("play", onPlay);
    };
  }, [playerId, cues]);

  // Brings a line into view inside the list only (the page itself never jumps).
  function reveal(line: HTMLElement | null | undefined) {
    const box = list.current;
    if (!box || !line) return;
    if (line.offsetTop < box.scrollTop || line.offsetTop + line.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = line.offsetTop - box.clientHeight / 3;
    }
  }

  useEffect(() => {
    if (following.current) reveal(list.current?.children[active] as HTMLElement | undefined);
  }, [active, cues]);

  useEffect(() => {
    if (current >= 0) reveal(list.current?.querySelector(`[data-match="${current}"]`)?.closest("li"));
  }, [current, matches]);

  // Back to following the video (the search cleared): the spoken line comes into view again, even while paused.
  function follow() {
    following.current = true;
    reveal(list.current?.children[active] as HTMLElement | undefined);
  }

  function step(back = false) {
    if (!matches.length) return;
    following.current = false;
    setCurrent((c) => stepMatch(c, matches.length, back));
  }

  const asText = () => transcriptText(cues, { title, language: shown.language, times });
  // Said anew each time (cleared first, so a repeated "copied" is heard again), and cleared when the text it was about
  // changes (Times, or another language).
  const tell = (message: string) => {
    setSaved("");
    requestAnimationFrame(() => setSaved(message));
  };
  useEffect(() => setSaved(""), [times, which]);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(asText());
      tell("Transcript copied.");
    } catch {
      tell("Could not copy: your browser did not allow it. Download it instead.");
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([asText()], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = transcriptFileName(title, shown.language);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // After the browser has taken the file.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    tell("Transcript downloaded.");
  }

  function playFrom(startMs: number) {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    following.current = true;
    el.currentTime = startMs / 1000;
    // Autoplay rules may refuse; the viewer then presses play from the new position.
    el.play().catch(() => undefined);
  }

  return (
    <section className="mt-6" aria-labelledby="share-transcript-title">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="share-transcript-title" className="text-sm font-semibold text-slate-200">
          Transcript{shown.language ? ` · ${shown.language}` : ""}
        </h2>
        <div role="group" aria-label="Save the transcript" className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1 text-slate-400">
            <input type="checkbox" checked={times} onChange={(e) => setTimes(e.target.checked)} className="accent-slate-300" />
            Times
          </label>
          <button type="button" onClick={copyText} className="rounded-md border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800">
            Copy transcript
          </button>
          <button type="button" onClick={download} className="rounded-md border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800">
            Download .txt
          </button>
        </div>
        <span role="status" className="w-full text-xs text-slate-400 empty:hidden" data-testid="share-transcript-saved">
          {saved}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          maxLength={TRANSCRIPT_QUERY_MAX}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value.trim()) follow();
          }}
          onKeyDown={(e) => {
            // Keys that finish or cancel an input method's composing (Japanese, Chinese, Korean) are its own.
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey);
            } else if (e.key === "Escape" && query) {
              // Clears the search; a second Escape is the page's again.
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
              follow();
            }
          }}
          aria-label="Search the transcript"
          aria-describedby="share-transcript-count"
          placeholder="Search the transcript"
          className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-slate-400 focus:outline-none"
        />
        <span id="share-transcript-count" role="status" className="min-w-16 text-xs text-slate-400" data-testid="share-transcript-count">
          {query.trim() ? (matches.length ? `${at + 1} of ${matches.length}` : "No matches") : ""}
        </span>
        <button type="button" onClick={() => step(true)} disabled={!matches.length} aria-label="Previous match" className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40">
          ↑
        </button>
        <button type="button" onClick={() => step()} disabled={!matches.length} aria-label="Next match" className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40">
          ↓
        </button>
      </div>
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
              <span>
                {(byLine.has(i) ? markLine(cue.text, i, matches, ...byLine.get(i)!) : [{ text: cue.text, match: undefined }]).map((piece, k) =>
                  piece.match === undefined ? (
                    piece.text
                  ) : (
                    <mark key={k} data-match={piece.match} aria-current={piece.match === at ? "true" : undefined} className={piece.match === at ? "rounded-sm bg-amber-300 text-slate-900" : "rounded-sm bg-amber-500/30 text-inherit"}>
                      {piece.text}
                    </mark>
                  ),
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
