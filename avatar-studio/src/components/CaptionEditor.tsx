"use client";
import { useState } from "react";
import { Captions, Plus, Trash2 } from "lucide-react";
import { Button, Card, inputClass } from "@/components/ui";
import { api } from "@/lib/client";
import type { CaptionCue, Video } from "@/lib/types";

const MAX_CUES = 500;
const MAX_CUE_CHARS = 300;

/** Seconds with one decimal, as the editor shows a cue's start and end. */
const toSec = (ms: number) => (Math.round(ms / 100) / 10).toFixed(1);
const toMs = (sec: string) => Math.round(Number(sec) * 1000);

/**
 * Fixes the captions in the script's language: each line's wording and when it shows. Saved lines serve the
 * share page and the caption downloads; "Follow the script" drops the corrections. Captions burned into the
 * rendered picture keep the original wording.
 */
export function CaptionEditor({ video, burnedIn, onUpdated }: { video: Video; burnedIn: boolean; onUpdated: (video: Video) => void }) {
  // Times are edited as text so a half-typed number ("1.") does not jump while the person types.
  const [rows, setRows] = useState<Array<{ start: string; end: string; text: string }> | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "reset" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const edited = !!video.captionCues?.length;

  async function open() {
    setBusy("load");
    setErr(null);
    setSaved(false);
    try {
      const { cues } = await api<{ cues: CaptionCue[] }>(`/api/videos/${video.id}/captions?format=json`);
      setRows(cues.map((c) => ({ start: toSec(c.startMs), end: toSec(c.endMs), text: c.text })));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load the captions");
    } finally {
      setBusy(null);
    }
  }

  function update(i: number, patch: Partial<{ start: string; end: string; text: string }>) {
    setRows((r) => r && r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
    setSaved(false);
  }

  /**
   * A new line after `i`: in the gap before the next line when there is one, a second long after the last line,
   * and otherwise the second half of line `i`'s time, since lines timed from the script follow on without gaps.
   */
  function addAfter(i: number) {
    setRows((r) => {
      if (!r || r.length >= MAX_CUES) return r;
      const rowStart = Number(r[i].start) || 0;
      const rowEnd = Number(r[i].end) || rowStart;
      const nextStart = r[i + 1] ? Number(r[i + 1].start) : NaN;
      let current = r[i];
      let span: [number, number];
      if (!r[i + 1]) span = [rowEnd, rowEnd + 1];
      else if (Number.isFinite(nextStart) && nextStart - rowEnd >= 0.2) span = [rowEnd, nextStart];
      else {
        const mid = Math.round(((rowStart + rowEnd) / 2) * 10) / 10;
        current = { ...current, end: mid.toFixed(1) };
        span = [mid, rowEnd];
      }
      const added = { start: span[0].toFixed(1), end: span[1].toFixed(1), text: "" };
      return [...r.slice(0, i), current, added, ...r.slice(i + 1)];
    });
    setSaved(false);
  }

  async function save() {
    if (!rows || busy) return;
    setBusy("save");
    setErr(null);
    const bad = rows.findIndex((r) => !r.start.trim() || !r.end.trim() || !Number.isFinite(Number(r.start)) || !Number.isFinite(Number(r.end)));
    if (bad >= 0) {
      setErr(`Line ${bad + 1} needs a start and an end in seconds, like 2.5`);
      setBusy(null);
      return;
    }
    try {
      const cues = rows.map((r) => ({ startMs: toMs(r.start), endMs: toMs(r.end), text: r.text }));
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}/captions`, { method: "PUT", body: JSON.stringify({ cues }) });
      onUpdated(next);
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the captions");
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (busy) return;
    setBusy("reset");
    setErr(null);
    try {
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}/captions`, { method: "DELETE" });
      onUpdated(next);
      setRows(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not reset the captions");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-4" data-testid="caption-editor">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Captions className="h-4 w-4 text-slate-400" /> Captions
        {edited && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700" data-testid="captions-edited">Edited</span>}
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Fix a word or when a line shows. Saved lines are used on the share page and in the caption downloads.
        {burnedIn && " Captions burned into the rendered picture keep the original wording."}
      </p>
      {!rows ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={open} loading={busy === "load"}>
            Edit captions
          </Button>
          {edited && (
            <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={reset} loading={busy === "reset"} title="Drop the corrections and time the captions from the script again">
              Follow the script
            </Button>
          )}
          {err && <span className="text-xs text-rose-600">{err}</span>}
        </div>
      ) : (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <ol className="max-h-96 space-y-2 overflow-y-auto pr-1" data-testid="caption-rows">
            {rows.map((row, i) => (
              <li key={i} className="rounded-lg border border-slate-200 p-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="w-6 font-medium text-slate-700">{i + 1}</span>
                  <label className="flex items-center gap-1">
                    From
                    <input aria-label={`Line ${i + 1} start (seconds)`} inputMode="decimal" value={row.start} onChange={(e) => update(i, { start: e.target.value })} className={`${inputClass} w-20 py-1`} />
                  </label>
                  <label className="flex items-center gap-1">
                    to
                    <input aria-label={`Line ${i + 1} end (seconds)`} inputMode="decimal" value={row.end} onChange={(e) => update(i, { end: e.target.value })} className={`${inputClass} w-20 py-1`} />
                  </label>
                  <span className="ml-auto flex items-center gap-1">
                    <button type="button" onClick={() => addAfter(i)} disabled={rows.length >= MAX_CUES} aria-label={`Add a line after line ${i + 1}`} title="Add a line after this one" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                      <Plus className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => setRows((r) => r && r.filter((_, j) => j !== i))} disabled={rows.length <= 1} aria-label={`Remove line ${i + 1}`} title="Remove this line" className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-700">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                </div>
                <textarea aria-label={`Line ${i + 1} text`} value={row.text} onChange={(e) => update(i, { text: e.target.value })} rows={2} maxLength={MAX_CUE_CHARS} className={`${inputClass} mt-1.5`} />
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" className="px-3 py-1.5 text-xs" loading={busy === "save"}>
              Save captions
            </Button>
            <Button type="button" variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setRows(null)} disabled={!!busy}>
              Close
            </Button>
            {edited && (
              <Button type="button" variant="secondary" className="px-3 py-1.5 text-xs" onClick={reset} loading={busy === "reset"}>
                Follow the script
              </Button>
            )}
            <span className="text-xs" role="status" data-testid="caption-status">
              {err ? <span className="text-rose-600">{err}</span> : saved ? <span className="text-emerald-700">Captions saved</span> : null}
            </span>
          </div>
        </form>
      )}
    </Card>
  );
}
