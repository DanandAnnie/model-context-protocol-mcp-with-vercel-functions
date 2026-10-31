"use client";
import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Check, Copy, Download, Link2, Pencil } from "lucide-react";
import { Button, Card, inputClass } from "@/components/ui";
import { captionDurationSec, chaptersText, sceneChapters, videoChapters, youtubeReadsChapters, type Timed } from "@/lib/chapters";
import { api } from "@/lib/client";
import { capSceneName, sceneName } from "@/lib/scene-text";
import { formatTimestamp } from "@/lib/text";
import { shareLinkAt } from "@/lib/share-time";
import type { Video } from "@/lib/types";

type ChapterVideo = Timed & Partial<Pick<Video, "views" | "chapterViews" | "deletedAt">> & { id?: string; status?: string; captionCues?: Array<{ startMs: number; endMs: number; text: string }> };

/**
 * A multi-scene video's chapters, one per scene, as the share page lists them, with a copy in the form a video
 * description takes ("0:00 Welcome"), so a video posted to YouTube keeps them. An editor can retitle them after the
 * video is made: each scene's name is its chapter's title, saved without rendering again.
 */
export function VideoChapters({
  video,
  canEdit = false,
  onSaved,
  shareOrigin,
}: {
  video: ChapterVideo;
  canEdit?: boolean;
  onSaved?: (video: Video) => void;
  /** Where share links live, when it is not this page's own origin. */
  shareOrigin?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [names, setNames] = useState<string[] | null>(null);
  // The names as they were when the form opened: what a field is compared with to know whether it was changed here,
  // since a refetch meanwhile may bring another editor's names into `video`.
  const [opened, setOpened] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);
  const refocusField = useRef(false);
  const formId = useId();
  const chapters = videoChapters(video);
  const scenes = video.scenes ?? [];
  // A video of two scenes or more can be given chapters by naming its scenes, even before it has two of its own.
  const editable = canEdit && !!video.id && scenes.length >= 2;
  // A video that can no longer be edited here (trashed, or the role changed) closes the form.
  useEffect(() => {
    if (!editable && names) {
      refocus.current = true;
      setNames(null);
    }
  }, [editable, names]);
  // Once the form has gone (and the Edit button is back), the focus returns to it, or to the heading if it is gone too;
  // done after the render rather than on a timer, which a save's later render could outrun.
  useEffect(() => {
    if (names || !refocus.current) return;
    refocus.current = false;
    (editButton.current ?? heading.current)?.focus();
  }, [names]);
  // After a failed save, once the fields are enabled again, the focus goes back to the first one.
  useEffect(() => {
    if (saving || !refocusField.current) return;
    refocusField.current = false;
    firstField.current?.focus();
  }, [saving, error]);
  // A link to the share page that starts at a chapter (`?t=`), for a made video that is not in the trash. Declared
  // before the early return below, as every hook must be, so a change in what the card shows keeps their order.
  const [linkCopied, setLinkCopied] = useState<number | null>(null);
  const linkable = video.status === "completed" && !video.deletedAt && !!video.id;
  if (chapters.length < 2 && !editable) return null;
  const text = chaptersText(chapters);
  const totalMs = captionDurationSec(video) * 1000;
  // How many share-page viewers played each chapter, once any has: the views a video had before chapters were counted
  // say nothing about its chapters, so they are neither shown as nobody's nor used as the share's base.
  const reach = video.status === "completed" && Object.keys(video.chapterViews ?? {}).length > 0;
  // What each chapter is called without a name, so a field left blank says what it falls back to; a scene starting
  // within the same second as the chapter before it is no chapter whatever its name.
  const fallbacks = sceneChapters(video, { ignoreNames: true });
  const tooClose = sceneChapters(video).map((c, i, all) => {
    if (!c || i === 0) return false;
    const before = all.slice(0, i).filter((x): x is NonNullable<typeof x> => !!x).at(-1);
    return !!before && Math.floor(c.startMs / 1000) <= Math.floor(before.startMs / 1000);
  });
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy these chapters", text);
    }
  }
  function open() {
    const now = scenes.map((sc) => sc.name ?? "");
    setOpened(now);
    setError(null);
    setSaved(null);
    // Committed before the handler returns, so letters typed straight after Enter land in the first field.
    flushSync(() => setNames(now));
    firstField.current?.focus();
  }
  function close() {
    refocus.current = true;
    setNames(null);
    setError(null);
  }
  async function copyLinkAt(i: number, startMs: number, nextMs?: number) {
    const url = shareLinkAt(`${(shareOrigin || window.location.origin).replace(/\/$/, "")}/share/${video.id}`, startMs, nextMs);
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(i);
      // Emptied first, so a second copy of the same link is announced again.
      setSaved(null);
      const message = `Link to ${formatTimestamp(startMs / 1000)} copied.`;
      setTimeout(() => setSaved(message), 50);
      setTimeout(() => setLinkCopied((at) => (at === i ? null : at)), 2000);
    } catch {
      window.prompt("Copy this link", url);
    }
  }
  async function save() {
    if (!names || !video.id || saving) return;
    // Only the names changed here are sent, so another editor's names on other scenes stay as they are.
    const changed: Record<string, string | null> = {};
    names.forEach((n, i) => {
      if ((sceneName(n) ?? null) !== (sceneName(opened[i]) ?? null)) changed[String(i + 1)] = sceneName(n) ?? null;
    });
    if (!Object.keys(changed).length) return close();
    setSaving(true);
    setError(null);
    try {
      const { video: next } = await api<{ video: Video }>(`/api/videos/${video.id}`, { method: "PATCH", body: JSON.stringify({ sceneNames: changed }) });
      onSaved?.(next);
      const count = Object.keys(changed).length;
      setSaved(`Saved ${count === 1 ? "1 chapter title" : `${count} chapter titles`}.`);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the chapter titles");
      // The fields were disabled while saving, so the focus goes back to the first one to try again.
      refocusField.current = true;
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card className="p-4" data-testid="chapters-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold text-slate-900 focus:outline-none">
          Chapters
        </h3>
        <div className="flex flex-wrap gap-2">
          {editable && !names && (
            <Button ref={editButton} variant="secondary" className="px-3 py-1.5" onClick={open}>
              <Pencil className="h-4 w-4" /> Edit titles
            </Button>
          )}
          {chapters.length >= 2 && (
            <Button variant="secondary" className="px-3 py-1.5" onClick={copy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy for YouTube"}
            </Button>
          )}
          {chapters.length >= 2 && video.id && video.status === "completed" && !video.deletedAt && (
            // The chapters as a WebVTT chapters file, for players and hosts that read one (the share page's player does).
            <a
              href={`/api/videos/${video.id}/captions?format=chapters`}
              download
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
              title="The chapters as a WebVTT chapters file, for video players and hosts that read one"
            >
              <Download className="h-4 w-4" /> Chapters file
            </a>
          )}
        </div>
      </div>
      <p role="status" className={saved ? "mt-2 text-xs text-emerald-700" : "sr-only"}>
        {saved ?? ""}
      </p>
      {names && editable && (
        // Each scene's name titles its chapter; a field left blank shows, as its placeholder, what the chapter falls back to.
        <form
          className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3"
          aria-label="Chapter titles"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !saving && !e.nativeEvent.isComposing) {
              e.preventDefault();
              close();
            }
          }}
        >
          <fieldset disabled={saving} className="space-y-2">
            {scenes.map((sc, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                <label htmlFor={`${formId}-${i}`} className="w-24 shrink-0 font-medium text-slate-600">
                  Scene {i + 1} title
                </label>
                <input
                  ref={i === 0 ? firstField : undefined}
                  id={`${formId}-${i}`}
                  className={`${inputClass} min-w-0 flex-1 py-1 text-xs`}
                  value={names[i] ?? ""}
                  placeholder={
                    tooClose[i]
                      ? "No chapter: it starts within a second of the one before"
                      : (fallbacks[i]?.title ?? "No chapter yet (a silent scene): a title gives it one")
                  }
                  onChange={(e) => {
                    // Cut at the limit as a reader counts characters, but not while an input method is building one.
                    const value = (e.nativeEvent as InputEvent).isComposing ? e.target.value : capSceneName(e.target.value);
                    setNames((prev) => prev && prev.map((n, j) => (j === i ? value : n)));
                  }}
                  onCompositionEnd={(e) => {
                    const value = capSceneName(e.currentTarget.value);
                    setNames((prev) => prev && prev.map((n, j) => (j === i ? value : n)));
                  }}
                />
              </div>
            ))}
          </fieldset>
          {error && (
            <p role="alert" className="text-xs font-medium text-red-700">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" className="px-3 py-1.5" loading={saving}>
              Save titles
            </Button>
            <Button type="button" variant="secondary" className="px-3 py-1.5" disabled={saving} onClick={close}>
              Cancel
            </Button>
            <span className="text-xs text-slate-500">A field left blank takes the scene&apos;s on-screen text or first words. The video is not rendered again.</span>
          </div>
        </form>
      )}
      {chapters.length >= 2 ? (
        <>
          <ol className="mt-2 space-y-1 text-sm" data-testid="video-chapters">
            {chapters.map((c, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-12 shrink-0 font-mono text-xs leading-5 text-slate-500">{formatTimestamp(c.startMs / 1000)}</span>
                <span className="min-w-0 text-slate-700">{c.title}</span>
                {reach && <ChapterReach played={video.chapterViews?.[String(c.scene)] ?? 0} />}
                {linkable && (
                  <button
                    type="button"
                    onClick={() => void copyLinkAt(i, c.startMs, chapters[i + 1]?.startMs)}
                    className={`${reach ? "" : "ml-auto "}-my-0.5 shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800`}
                    aria-label={`Copy a link to ${c.title}, at ${formatTimestamp(c.startMs / 1000)}`}
                    title="Copy a link that starts here"
                    data-testid="chapter-link"
                  >
                    {linkCopied === i ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                  </button>
                )}
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-slate-500">
            {video.status !== "completed"
              ? "Times are estimated until the video renders."
              : !video.durationSec
                ? "The renderer did not report the video's length, so times are estimated from the script."
                : video.captionCues?.length
                  ? "Times follow the corrected captions."
                  : "Times follow each scene's share of the video, as the captions do."}{" "}
            {reach && "Viewers are those who played each chapter on the share page or an embed, once each per 10 minutes (a muted autoplay counts once the sound is on). "}
            {youtubeReadsChapters(chapters, totalMs)
              ? "Paste them into a YouTube description to show them as chapters there."
              : "YouTube shows chapters only when there are at least three, each 10 seconds or longer, so it would list these as plain text."}
          </p>
        </>
      ) : (
        <p className="mt-2 text-xs text-slate-500">No chapters yet: a silent scene, or one starting within a second of the one before, is no chapter of its own. A title gives a silent scene one.</p>
      )}
    </Card>
  );
}

/** Share-page viewers who played a chapter. */
function ChapterReach({ played }: { played: number }) {
  return (
    <span className="ml-auto shrink-0 pl-2 text-xs leading-5 tabular-nums text-slate-500" data-testid="chapter-viewers">
      {played} {played === 1 ? "viewer" : "viewers"}
      <span className="sr-only"> played this chapter</span>
    </span>
  );
}
