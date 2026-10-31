"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Download, Scissors, Trash2 } from "lucide-react";
import { Button, Card, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { api } from "@/lib/client";
import { HIGHLIGHT_FRAMES, HIGHLIGHT_LENGTHS, type HighlightFrame, type HighlightJob, type HighlightLength, type Video } from "@/lib/types";

/** A set as the server lists it: never the renderer or its job id. */
type Highlight = Omit<HighlightJob, "ownerId" | "provider" | "providerJobId">;
/** Finished clips' links are renewed by the server once this old; a page left open asks again when it is looked at. */
const RELINK_MS = 30 * 60 * 1000;
/** Sets a video keeps (the server refuses more). */
const MAX_SETS = 5;

const LENGTH_NAMES: Record<HighlightLength, string> = { "30": "30 seconds", "60": "1 minute", "180": "3 minutes" };
const FRAME_NAMES: Record<HighlightFrame, string> = { "9:16": "9:16 portrait (stories, reels, shorts)", "16:9": "16:9 landscape", "1:1": "1:1 square" };

/**
 * "Short clips": the renderer picks the best moments of a finished video and cuts them into short clips, one per chosen
 * length (HeyGen AI Clipping), framed for social media, with captions burned in or not and an optional note on what to
 * look for. Each set is listed with its clips to watch and download; viewers see the sets, editors make and delete them.
 */
export function HighlightClips({ video, canEdit }: { video: Video; canEdit: boolean }) {
  const id = useId();
  const { data, error: loadError, setData, refetch } = useApi<{ highlights: Highlight[]; available: boolean }>(`/api/videos/${video.id}/highlights`);
  const running = (data?.highlights ?? []).some((h) => h.status === "processing");
  useEffect(() => {
    if (!running) return;
    // Not while the tab is hidden: nobody is reading it, and each check asks the renderer.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 10_000);
    return () => clearInterval(timer);
  }, [running, refetch]);
  // A page left open past the clips' link lifetime asks again when it is looked at, so the player and links still work.
  const loadedAt = useRef(Date.now());
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - loadedAt.current > RELINK_MS) {
        loadedAt.current = Date.now();
        void refetch();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);
  // Lengths as long as the video or longer have no highlight, so they are not offered.
  const lengths = HIGHLIGHT_LENGTHS.filter((l) => !video.durationSec || Number(l) < video.durationSec);
  const [chosen, setChosen] = useState<HighlightLength[]>(["30"]);
  const [frame, setFrame] = useState<HighlightFrame>("9:16");
  const [captions, setCaptions] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A set that finishes or fails while the page is open is announced.
  const seen = useRef<Map<string, Highlight["status"]>>(new Map());
  useEffect(() => {
    // Sets that finish in the same check are announced together.
    let ready = 0;
    const failed: string[] = [];
    for (const h of data?.highlights ?? []) {
      const before = seen.current.get(h.id);
      if (before === "processing" && h.status === "completed") ready += h.clips.length;
      if (before === "processing" && h.status === "failed") failed.push(h.error ?? "the renderer failed");
      seen.current.set(h.id, h.status);
    }
    const parts = [...(ready ? [`${ready === 1 ? "1 clip is" : `${ready} clips are`} ready.`] : []), ...failed.map((e) => `Some clips could not be cut: ${e}.`)];
    if (parts.length) setNote(parts.join(" "));
  }, [data]);
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterRender = useFocusAfterRender();
  const sets = data?.highlights ?? [];
  const sending = chosen.filter((l) => lengths.includes(l));
  const canMake = canEdit && !video.deletedAt && video.status === "completed" && !!data?.available;
  // Until the first answer the card shows, so a failed load is said rather than hidden.
  if (data && !canMake && sets.length === 0) return null;

  async function make() {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const { highlight } = await api<{ highlight: Highlight }>(`/api/videos/${video.id}/highlights`, { method: "POST", body: JSON.stringify({ lengths: sending, frame, captions, prompt }) });
      setData((prev) => ({ available: prev?.available ?? true, highlights: [highlight, ...(prev?.highlights ?? [])] }));
      // A check that left before this set was made would answer without it; asking again retires it.
      void refetch();
      setNote("Cutting the clips; they appear here when they are ready.");
      focusAfterRender(() => listRef.current?.querySelector<HTMLElement>(`[data-highlight="${highlight.id}"]`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The clips could not be started");
    } finally {
      setBusy(false);
    }
  }

  async function remove(job: Highlight) {
    if (!window.confirm(job.status === "processing" ? "Delete these clips? They are still being cut, and cutting them again uses another job." : "Delete these clips? Cutting them again uses another job.")) return;
    setErr(null);
    setNote(null);
    const next = sets[sets.indexOf(job) + 1] ?? sets[sets.indexOf(job) - 1];
    try {
      await api(`/api/videos/${video.id}/highlights/${job.id}`, { method: "DELETE" });
      setData((prev) => (prev ? { ...prev, highlights: prev.highlights.filter((h) => h.id !== job.id) } : prev));
      void refetch();
      setNote(`Clips deleted (${job.lengths.map((l) => LENGTH_NAMES[l]).join(", ")}).`);
      // Focus moves to the next set, or to the card's heading, rather than being lost with the button.
      focusAfterRender(() => (next ? listRef.current?.querySelector<HTMLElement>(`[data-highlight="${next.id}"]`) : headingRef.current));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The clips could not be deleted");
    }
  }

  return (
    <Card className="p-4" data-testid="highlight-clips">
      <h3 ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-sm font-semibold text-slate-900 outline-none">
        <Scissors className="h-4 w-4" aria-hidden /> Short clips
      </h3>
      <p role="status" className="sr-only">
        {note ?? ""}
      </p>
      {loadError && <p className="mt-2 text-xs text-rose-600">The clips could not be loaded: {loadError}</p>}
      {sets.length > 0 && (
        <ul ref={listRef} className="mt-2 space-y-3">
          {sets.map((h) => (
            <li key={h.id} data-highlight={h.id} tabIndex={-1} className="rounded-lg border border-slate-200 p-3 outline-none focus:ring-2 focus:ring-brand-500">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 break-words text-xs text-slate-600">
                  {h.lengths.map((l) => LENGTH_NAMES[l]).join(", ")} · {h.frame} · {h.captions ? "captions" : "no captions"}
                  {h.prompt ? ` · “${h.prompt}”` : ""}
                </p>
                {canEdit && (
                  <button type="button" onClick={() => remove(h)} className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" aria-label={`Delete these clips (${h.lengths.map((l) => LENGTH_NAMES[l]).join(", ")})`}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              {h.status === "processing" && (
                <p className="mt-1 text-xs text-slate-500" data-testid="highlight-status">
                  Cutting{typeof h.progress === "number" ? ` (${h.progress}%)` : ""}…
                </p>
              )}
              {h.status === "failed" && <p className="mt-1 text-xs text-rose-600">{h.error ?? "The clips could not be cut."}</p>}
              {h.clips.length > 0 && (
                <ul className="mt-2 grid gap-3 sm:grid-cols-2">
                  {h.clips.map((c) => (
                    <li key={c.id} className="min-w-0" data-testid="highlight-clip">
                      {c.status === "completed" && c.videoUrl ? (
                        <video src={c.videoUrl} poster={c.thumbnailUrl} controls preload="none" className={`rounded-md bg-black ${h.frame === "9:16" ? "mx-auto block aspect-[9/16] h-80 max-w-full" : h.frame === "1:1" ? "aspect-square w-full" : "aspect-video w-full"}`} aria-label={c.title ?? "Highlight clip"} />
                      ) : (
                        <p className="text-xs text-slate-500">{c.status === "failed" ? "This clip could not be cut." : "Still cutting…"}</p>
                      )}
                      <p className="mt-1 truncate text-sm font-medium text-slate-800" title={c.title}>
                        {c.title ?? "Highlight"}
                      </p>
                      <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                        {typeof c.durationSec === "number" && <span>{Math.round(c.durationSec)}s</span>}
                        {typeof c.viralityScore === "number" && <span title="The renderer's estimate of how well it would do on social media">Virality {c.viralityScore}/100</span>}
                        {c.videoUrl && (
                          <a href={c.videoUrl} target="_blank" rel="noopener noreferrer" aria-label={`Download ${c.title ?? "this clip"}`} className="inline-flex items-center gap-1 text-brand-700 underline">
                            <Download className="h-3 w-3" aria-hidden /> Download
                          </a>
                        )}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {canMake && (
        <>
          <p className="mt-2 text-xs text-slate-500">
            The renderer picks the best moments of this video and cuts a short clip of each length, framed for social media. The clips are not added to the library; download the ones you want.
          </p>
          {sets.length >= MAX_SETS ? (
            <p className="mt-2 text-xs text-slate-500">This video keeps at most {MAX_SETS} sets of clips; delete one to cut more.</p>
          ) : lengths.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">This video is shorter than the shortest clip (30 seconds).</p>
          ) : (
            <div className="mt-2 space-y-3">
              <fieldset>
                <legend className="text-xs font-medium text-slate-700">Clip lengths</legend>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  {lengths.map((l) => (
                    <label key={l} className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" className="accent-brand-600" checked={chosen.includes(l)} onChange={(e) => setChosen((prev) => (e.target.checked ? [...prev, l] : prev.filter((x) => x !== l)))} />
                      {LENGTH_NAMES[l]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="block text-xs font-medium text-slate-700">
                Framing
                <select className={`${inputClass} mt-1`} value={frame} onChange={(e) => setFrame(e.target.value as HighlightFrame)}>
                  {HIGHLIGHT_FRAMES.map((f) => (
                    <option key={f} value={f}>
                      {FRAME_NAMES[f]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="accent-brand-600" checked={captions} onChange={(e) => setCaptions(e.target.checked)} />
                Burn in captions
              </label>
              <label className="block text-xs font-medium text-slate-700">
                What to look for (optional)
                <input className={`${inputClass} mt-1`} value={prompt} maxLength={500} onChange={(e) => setPrompt(e.target.value)} placeholder="The moments about the kitchen and the price" aria-describedby={`${id}-prompt`} />
              </label>
              <p id={`${id}-prompt`} className="text-xs text-slate-500">
                Left empty, the renderer chooses on its own.
              </p>
              <Button variant="secondary" className="px-3 py-1.5" onClick={make} loading={busy} disabled={!sending.length}>
                {sending.length === 0 ? "Choose a length" : sending.length === 1 ? "Cut 1 clip" : `Cut ${sending.length} clips`}
              </Button>
            </div>
          )}
        </>
      )}
      {err && (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          {err}
        </p>
      )}
    </Card>
  );
}
