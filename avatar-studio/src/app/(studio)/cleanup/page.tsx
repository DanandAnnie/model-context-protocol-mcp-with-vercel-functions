"use client";
import { useEffect, useRef, useState } from "react";
import { Download, Eraser, Pencil, Trash2 } from "lucide-react";
import { Button, Card, EmptyState, ErrorBanner, Field, SectionTitle, StatusBadge, inputClass } from "@/components/ui";
import { ListSearch, useListSearch } from "@/components/ListSearch";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { ApiError, api, formatDate, formatSeconds, isRefusal } from "@/lib/client";
import type { CleanupJob, Video } from "@/lib/types";

/** A cleanup as the server lists it: never the renderer or its job id. */
type Cleanup = Omit<CleanupJob, "ownerId" | "provider" | "providerJobId">;
/** A fresh key for one start (a UUID where the browser has one, as it does over https and on localhost). */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
/** Cleaned recordings' links are renewed by the server once this old; a page left open asks again when it is looked at. */
const RELINK_MS = 30 * 60 * 1000;

/**
 * "Clean up": filler words ("um", "uh") and overlong silences cut out of a recording, one cleaned cut back (HeyGen
 * filler word removal). For a recording someone spoke off the cuff: a webinar, a screen recording, an interview, or a
 * video of the library. The cleaned cut is listed with how much was cut, to watch and download.
 */
export default function CleanupPage() {
  const canEdit = useCanEdit();
  const { data, error, setData, refetch } = useApi<{ cleanups: Cleanup[]; available: boolean }>("/api/cleanups");
  // While a cleanup runs the list is asked again, only while the tab is visible (nobody is reading it otherwise), and a
  // failed check does not stop the next one.
  const running = (data?.cleanups ?? []).some((c) => c.status === "processing");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 10_000);
    return () => clearInterval(timer);
  }, [running, refetch]);
  const { data: library } = useApi<{ videos: Video[]; hasMore?: boolean }>("/api/videos?status=completed&limit=200");
  const videos = (library?.videos ?? []).filter((v) => v.videoUrl && !v.deletedAt);
  const [from, setFrom] = useState<"link" | "library">("link");
  const [sourceUrl, setSourceUrl] = useState("");
  const [videoId, setVideoId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // One key per start: a retry of the same start (after a timeout, say) sends it again and gets the same cleanup back.
  const [requestKey, setRequestKey] = useState(() => newKey());
  const sourceInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterRender = useFocusAfterRender();
  // A cleanup that finishes or fails while the page is open is announced.
  const seen = useRef<Map<string, { status: Cleanup["status"]; title: string }>>(new Map());
  useEffect(() => {
    if (!data) return;
    // Cleanups that finish in the same check are announced together.
    const parts: string[] = [];
    for (const c of data.cleanups) {
      const before = seen.current.get(c.id)?.status;
      if (before === "processing" && c.status !== "processing") parts.push(c.status === "completed" ? `${c.title} is cleaned up.` : `${c.title} could not be cleaned up: ${c.error ?? "the renderer failed"}.`);
      seen.current.set(c.id, { status: c.status, title: c.title });
    }
    // One that leaves the list without being deleted here went with its video (deleted for good), or was deleted elsewhere.
    const listed = new Set(data.cleanups.map((c) => c.id));
    for (const [id, was] of seen.current) {
      if (listed.has(id)) continue;
      parts.push(`${was.title} is no longer listed; it went with its video, or was deleted elsewhere.`);
      seen.current.delete(id);
    }
    if (parts.length) setNote(parts.join(" "));
  }, [data]);
  // A page left open past the links' lifetime asks again when it is looked at, so the players and links still work.
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

  const items = data?.cleanups ?? [];
  const search = useListSearch();
  const shown = items.filter((c) => search.matches(c.id, c.title));
  // A different source is a different start: its own key, and an error about the last one no longer applies.
  function switchTo(next: "link" | "library") {
    setFrom(next);
    setErr(null);
    setRequestKey(newKey());
  }
  const ready = from === "link" ? /^https:\/\/\S+$/i.test(sourceUrl.trim()) : !!videoId;
  const canStart = canEdit !== false && data?.available !== false;

  async function submit() {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const body = from === "link" ? { sourceUrl: sourceUrl.trim(), ...(title.trim() ? { title: title.trim() } : {}) } : { videoId, ...(title.trim() ? { title: title.trim() } : {}) };
      const { cleanup } = await api<{ cleanup: Cleanup }>("/api/cleanups", { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": requestKey } });
      setData((prev) => ({ available: prev?.available ?? true, cleanups: [cleanup, ...(prev?.cleanups ?? []).filter((c) => c.id !== cleanup.id)] }));
      // A check that left before this cleanup was started would answer without it; asking again retires it.
      void refetch();
      setRequestKey(newKey());
      setSourceUrl("");
      setVideoId("");
      setTitle("");
      // Shown even when a search is typed that it does not match.
      search.pin(cleanup.id);
      setNote(`Cleaning up ${cleanup.title}; it appears here when it is ready.`);
      // Focus goes to the new cleanup, rather than being lost with the cleared form.
      focusAfterRender(() => listRef.current?.querySelector<HTMLElement>(`[data-cleanup="${cleanup.id}"]`) ?? sourceInput.current);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The recording could not be cleaned up");
      // A refusal is an answer: trying again (after topping up, say) is a new start. A lost answer, or one HeyGen is still
      // working on, keeps its key, so a retry returns the start that may have gone through.
      if (isRefusal(e)) setRequestKey(newKey());
    } finally {
      setBusy(false);
    }
  }

  async function rename(c: Cleanup) {
    const answer = window.prompt("Cleanup name", c.title);
    const name = answer?.trim();
    if (!name || name === c.title) return;
    setErr(null);
    setNote(null);
    try {
      const { cleanup: saved } = await api<{ cleanup: Cleanup }>(`/api/cleanups/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: name }) });
      setData((prev) => (prev ? { ...prev, cleanups: prev.cleanups.map((x) => (x.id === saved.id ? saved : x)) } : prev));
      // A list check that left before the rename would answer with the old name; asking again retires it.
      void refetch();
      search.pin(saved.id);
      setNote(`Renamed the cleanup to “${saved.title}”.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        // Forgotten here, so the next check does not announce it as deleted elsewhere as well.
        seen.current.delete(c.id);
        setData((prev) => (prev ? { ...prev, cleanups: prev.cleanups.filter((x) => x.id !== c.id) } : prev));
        setNote(`The cleanup “${c.title}” is no longer available.`);
        focusAfterRender(() => headingRef.current);
      } else setErr(e instanceof Error ? e.message : "The cleanup could not be renamed");
    }
  }

  async function remove(c: Cleanup) {
    if (!window.confirm(`Delete “${c.title}”? Cleaning it again uses another job.`)) return;
    setErr(null);
    setNote(null);
    const next = shown[shown.indexOf(c) + 1] ?? shown[shown.indexOf(c) - 1];
    // Kept in view while the delete is sent, so a search typed meanwhile cannot hide where the focus goes.
    if (next) search.pin(next.id);
    try {
      // Forgotten before the request, so a check landing meanwhile does not announce it as deleted elsewhere.
      seen.current.delete(c.id);
      await api(`/api/cleanups/${c.id}`, { method: "DELETE" });
      setData((prev) => (prev ? { ...prev, cleanups: prev.cleanups.filter((x) => x.id !== c.id) } : prev));
      void refetch();
      setNote(`Deleted ${c.title}.`);
      // Focus moves to the next cleanup, or to the list's heading, rather than being lost with the button.
      focusAfterRender(() => (next ? listRef.current?.querySelector<HTMLElement>(`[data-cleanup="${next.id}"]`) : headingRef.current));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The cleanup could not be deleted");
    }
  }

  return (
    <>
      <SectionTitle title="Clean up a recording" subtitle="Cut the filler words (“um”, “uh”) and long silences out of a recording, and get one cleaned video back." />
      {canEdit === false && <ViewOnlyNotice what="clean up recordings" />}
      {/* A failed list load and a refused start are both shown; neither hides the other. */}
      <ErrorBanner message={error} />
      <ErrorBanner message={err} />
      <p role="status" className="sr-only">
        {note ?? ""}
      </p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card className="p-5">
          {data?.available === false ? (
            <p className="text-sm text-slate-600">Cleaning up recordings needs the HeyGen renderer; the current renderer has no such feature.</p>
          ) : (
            <div className="space-y-4">
              <fieldset>
                <legend className="mb-1.5 block text-sm font-medium text-slate-700">Recording</legend>
                <div className="flex flex-wrap gap-4 text-sm text-slate-700">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="cleanup-from" className="accent-brand-600" checked={from === "link"} disabled={canEdit === false} onChange={() => switchTo("link")} />
                    A link
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="cleanup-from" className="accent-brand-600" checked={from === "library"} disabled={canEdit === false} onChange={() => switchTo("library")} />
                    One of my videos
                  </label>
                </div>
              </fieldset>
              {from === "link" ? (
                <Field label="Recording URL" hint="A public https link to a video with speech, up to 2 hours long: a webinar, a screen recording, an interview.">
                  <input ref={sourceInput} type="url" inputMode="url" className={inputClass} value={sourceUrl} disabled={canEdit === false} onChange={(e) => {
                      setSourceUrl(e.target.value);
                      setErr(null);
                      setRequestKey(newKey());
                    }} placeholder="https://…/webinar.mp4" />
                </Field>
              ) : (
                <Field label="Video" hint={!library ? "Loading your videos…" : videos.length ? (library.hasMore ? "Your 200 newest finished videos." : "A finished video of your library.") : "No finished videos yet."}>
                  <select
                    className={inputClass}
                    value={videoId}
                    disabled={canEdit === false}
                    onChange={(e) => {
                      setVideoId(e.target.value);
                      setErr(null);
                      setRequestKey(newKey());
                    }}
                  >
                    <option value="">Choose a video</option>
                    {videos.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Title (optional)">
                <input className={inputClass} value={title} maxLength={120} disabled={canEdit === false} onChange={(e) => setTitle(e.target.value)} placeholder={from === "library" ? "The video's title, marked cleaned" : "Cleaned recording"} />
              </Field>
              <Button onClick={submit} loading={busy} disabled={!ready || !canStart} className="w-full">
                <Eraser className="h-4 w-4" /> Clean up recording
              </Button>
              <p className="text-xs text-slate-500">The cleaned video is not added to the library; download it once it is ready. When nothing needs cutting, the renderer hands back a copy and does not charge for it.</p>
            </div>
          )}
        </Card>

        <div ref={listRef}>
          <h2 ref={headingRef} tabIndex={-1} className="mb-3 text-sm font-semibold text-slate-900 outline-none">
            Cleaned recordings
          </h2>
          {data && (items.length > 0 || search.q) && <ListSearch search={search} label="Search cleanups" placeholder="Search by name" shown={shown.length} total={items.length} noun="cleanups" />}
          {!data ? null : items.length === 0 ? (
            <EmptyState icon={<Eraser className="h-8 w-8" />} title="No cleaned recordings yet" body="Clean up a recording on the left to get started." />
          ) : (
            <div className="space-y-3">
              {shown.map((c) => (
                <Card key={c.id} className="p-4 outline-none focus:ring-2 focus:ring-brand-500" data-testid="cleanup" data-cleanup={c.id} tabIndex={-1}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900">{c.title}</div>
                      <div className="mt-0.5 text-xs text-slate-500" data-testid="cleanup-meta">
                        {c.videoId ? "From the library" : "From a link"} · {formatDate(c.createdAt)}
                        {c.status === "processing" && typeof c.progress === "number" ? ` · ${c.progress}%` : ""}
                      </div>
                      {c.status === "completed" && (
                        <div className="mt-1 text-xs text-slate-600" data-testid="cleanup-stats">
                          {typeof c.cuts === "number" ? `${c.cuts} filler ${c.cuts === 1 ? "cut" : "cuts"}` : "Cleaned"}
                          {typeof c.originalSec === "number" && typeof c.outputSec === "number" ? ` · ${formatSeconds(Math.round(c.originalSec))} → ${formatSeconds(Math.round(c.outputSec))}` : ""}
                          {typeof c.reductionPct === "number" ? ` (${c.reductionPct}% shorter)` : ""}
                        </div>
                      )}
                      {c.error && <div className="mt-1 text-xs text-rose-600">{c.error}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={c.status} />
                      {canEdit === true && (
                        <>
                          <button type="button" onClick={() => void rename(c)} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-brand-700" aria-label={`Rename ${c.title}`} title="Rename">
                            <Pencil className="h-4 w-4" aria-hidden />
                          </button>
                          <button type="button" onClick={() => remove(c)} className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-rose-600" aria-label={`Delete ${c.title}`} title="Delete">
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {c.status === "completed" && c.videoUrl && (
                    <>
                      <video src={c.videoUrl} poster={c.thumbnailUrl} controls preload="none" className="mt-3 w-full rounded-lg bg-black" aria-label={c.title} />
                      <a href={c.videoUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline" aria-label={`Download ${c.title}`}>
                        <Download className="h-3 w-3" aria-hidden /> Download
                      </a>
                    </>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
