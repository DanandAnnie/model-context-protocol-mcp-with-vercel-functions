"use client";
import { useId, useRef, useState } from "react";
import { PenLine } from "lucide-react";
import { Button, Card, ErrorBanner, inputClass } from "@/components/ui";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { ApiError, api } from "@/lib/client";
import { MAX_LINE_CHARS, MAX_LINE_FIX_SCENES, speaks, spokenLines } from "@/lib/line-fixes";
import type { Video } from "@/lib/types";

/**
 * "Fix a line" for a finished video: each spoken scene's words in a box; only the scenes whose words change are
 * re-rendered by HeyGen, in this same video (its link, views, and comments stay). The words are those the page read,
 * so a fix written against words changed meanwhile (another tab) is refused and offered to open again.
 */
export function LineFixes({ video, onFixed, onRefresh }: { video: Video; onFixed: (next: Video) => void; onRefresh: () => void }) {
  const id = useId();
  const focusAfterRender = useFocusAfterRender();
  const openButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  /** A fix being sent or rendered: the panel says so, and a new fix waits for it. */
  const rendering = !!video.lineFix?.pending;
  /** The words as read when the fix was opened, by scene number, and what they are changed to. */
  const [read, setRead] = useState<Record<number, string> | null>(null);
  const [words, setWords] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [note, setNote] = useState("");
  const lines = spokenLines(video);
  const names = video.scenes?.map((s) => s.name) ?? [];
  const changed = read ? Object.entries(words).filter(([n, w]) => w.trim() !== read[Number(n)]?.trim()) : [];
  const silent = changed.find(([, w]) => !speaks(w));
  const tooMany = changed.length > MAX_LINE_FIX_SCENES;

  function open() {
    const spoken = lines.filter((l) => l.spoken);
    setRead(Object.fromEntries(spoken.map((l) => [l.scene, l.script])));
    setWords(Object.fromEntries(spoken.map((l) => [l.scene, l.script])));
    setErr(null);
    setStale(false);
    focusAfterRender(() => document.getElementById(`${id}-scene-${spoken[0]?.scene}`));
  }

  function close() {
    setRead(null);
    setErr(null);
    focusAfterRender(() => openButton.current);
  }

  async function send() {
    if (!read || !changed.length || silent || tooMany) return;
    setSending(true);
    setErr(null);
    setStale(false);
    try {
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}/lines`, {
        method: "POST",
        body: JSON.stringify({ scenes: changed.map(([n, w]) => ({ scene: Number(n), from: read[Number(n)], script: w.trim() })) }),
      });
      const fixed = next.lineFix?.scenes ?? changed.map(([n]) => Number(n));
      setRead(null);
      setNote(`Re-rendering ${fixed.length === 1 ? `scene ${fixed[0]}` : `scenes ${fixed.join(", ")}`} with the new words. The video is ready again in a few minutes, at the same link.`);
      onFixed(next);
      focusAfterRender(() => heading.current);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The fix could not be sent");
      // The words may have changed elsewhere: the video is read again, so opening them again shows the current ones.
      if (e instanceof ApiError && e.status === 409) {
        setStale(true);
        onRefresh();
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="p-5" data-testid="line-fixes">
      <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold text-slate-900 outline-none">
        Fix a line
      </h3>
      <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
        Change the words of the scenes that need it; HeyGen re-renders only those, in this same video, so its link, views, and comments stay. It counts as a render, and the video is unavailable on its share page until the new render is ready, usually in a few minutes.
      </p>
      <p role="status" className="sr-only">
        {note}
      </p>
      {rendering && (
        <p className="mt-2 text-xs text-slate-600" data-testid="line-fix-rendering">
          Re-rendering {video.lineFix!.scenes.length === 1 ? `scene ${video.lineFix!.scenes[0]}` : `scenes ${video.lineFix!.scenes.join(", ")}`} with the new words. This page updates when it is ready.
        </p>
      )}
      {!rendering && video.lineFix?.error && (
        <p className="mt-2 text-xs text-amber-800" data-testid="line-fix-error">
          The last fix did not take: {video.lineFix.error}. The video is as it was before it.
        </p>
      )}
      <ErrorBanner message={err} />
      {stale && (
        <Button variant="secondary" className="mt-2" onClick={open}>
          Open the words again
        </Button>
      )}
      {rendering ? null : !read ? (
        <Button ref={openButton} variant="secondary" className="mt-3" onClick={open} aria-describedby={`${id}-hint`}>
          <PenLine className="h-4 w-4" /> Fix a line
        </Button>
      ) : (
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          onKeyDown={(e) => e.key === "Escape" && !sending && !e.nativeEvent.isComposing && close()}
        >
          <ol className="space-y-3">
            {lines
              .filter((l) => l.spoken)
              .map((l) => (
                <li key={l.scene} className="min-w-0">
                  <label htmlFor={`${id}-scene-${l.scene}`} className="block text-sm font-medium text-slate-800 [overflow-wrap:anywhere]">
                    Scene {l.scene}
                    {names[l.scene - 1] ? ` · ${names[l.scene - 1]}` : ""}
                  </label>
                  <textarea
                    id={`${id}-scene-${l.scene}`}
                    className={`${inputClass} mt-1 min-h-20`}
                    maxLength={MAX_LINE_CHARS}
                    disabled={sending}
                    value={words[l.scene] ?? ""}
                    onChange={(e) => setWords((all) => ({ ...all, [l.scene]: e.target.value }))}
                  />
                </li>
              ))}
          </ol>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={sending} disabled={!changed.length || !!silent || tooMany} aria-describedby={`${id}-count`}>
              {changed.length > 1 ? `Re-render ${changed.length} scenes` : "Re-render the scene"}
            </Button>
            <button type="button" className="text-xs font-medium text-slate-600 hover:underline" onClick={close} disabled={sending}>
              Cancel
            </button>
            <span id={`${id}-count`} className="text-xs text-slate-500" aria-live="polite">
              {silent
                ? `Scene ${silent[0]} needs words to speak, not only pauses.`
                : tooMany
                  ? `One fix changes at most ${MAX_LINE_FIX_SCENES} scenes; ${changed.length} are changed.`
                  : changed.length
                    ? `${changed.length} ${changed.length === 1 ? "scene" : "scenes"} changed.`
                    : "Change the words of a scene to fix it."}
            </span>
          </div>
        </form>
      )}
    </Card>
  );
}
