"use client";
import { useEffect, useRef, useState } from "react";
import { Download, Music, Search, Trash2 } from "lucide-react";
import { Button, Card, EmptyState, ErrorBanner, Field, SectionTitle, StatusBadge, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { api, formatDate, formatSeconds, isRefusal } from "@/lib/client";
import { MUSIC_VOLUMES, type MusicJob, type MusicTrack, type MusicVolume, type Video } from "@/lib/types";

/** A mix as the server lists it: never the renderer or its job id. */
type Mix = Omit<MusicJob, "ownerId" | "provider" | "providerJobId">;
/** A fresh key for one start (a UUID where the browser has one, as it does over https and on localhost). */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
/** Mixed videos' links are renewed by the server once this old; a page left open asks again when it is looked at. */
const RELINK_MS = 30 * 60 * 1000;
const VOLUME_LABEL: Record<MusicVolume, string> = { quiet: "Quiet", low: "Low", medium: "Medium", high: "High" };
/** A mix's name for its controls: its title, track, and day, as one video can be given music more than once. */
const mixName = (m: Mix) => `${m.title}, “${m.trackName}”, ${formatDate(m.createdAt)}`;
const SUGGESTIONS = ["Calm ambient corporate", "Upbeat and motivational", "Cinematic and inspiring"];

/**
 * "Music": a track of the renderer's music catalog, found by describing it, mixed under a finished library video and
 * rendered as a new video to download (HeyGen's music catalog and HyperFrames). The track repeats to the video's length
 * and fades in and out; the video's own sound stays as it is.
 */
export default function MusicPage() {
  const canEdit = useCanEdit();
  const { data, error, setData, refetch } = useApi<{ mixes: Mix[]; available: boolean }>("/api/music");
  // While a mix renders the list is asked again, only while the tab is visible.
  const running = (data?.mixes ?? []).some((m) => m.status === "processing");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 10_000);
    return () => clearInterval(timer);
  }, [running, refetch]);
  const { data: library, refetch: refetchLibrary } = useApi<{ videos: Video[]; hasMore?: boolean; rendering?: number }>("/api/videos?status=completed&limit=200");
  // A video that finishes while the page is open joins the choices: the list is asked again while renders are in flight,
  // for up to ten minutes (a render whose start never came back stays "queued"), and whenever the tab comes back.
  const libraryRendering = (library?.rendering ?? 0) > 0;
  useEffect(() => {
    if (!libraryRendering) return;
    let checks = 0;
    const timer = setInterval(() => {
      if (++checks > 60) return clearInterval(timer);
      if (document.visibilityState === "visible") void refetchLibrary();
    }, 10_000);
    return () => clearInterval(timer);
  }, [libraryRendering, refetchLibrary]);
  const videos = (library?.videos ?? []).filter((v) => v.videoUrl && !v.deletedAt && !v.transparent);
  const [videoId, setVideoId] = useState("");
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null);
  const [trackId, setTrackId] = useState("");
  const [volume, setVolume] = useState<MusicVolume>("low");
  const [title, setTitle] = useState("");
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // One key per start: a retry of the same start (after a timeout, say) sends it again and gets the same mix back.
  const [requestKey, setRequestKey] = useState(() => newKey());
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tracksRef = useRef<HTMLFieldSetElement>(null);
  const videoRef = useRef<HTMLSelectElement>(null);
  const focusAfterRender = useFocusAfterRender();
  // A mix that finishes or fails while the page is open is announced.
  const seen = useRef<Map<string, { status: Mix["status"]; title: string }>>(new Map());
  useEffect(() => {
    if (!data) return;
    const parts: string[] = [];
    for (const m of data.mixes) {
      const before = seen.current.get(m.id)?.status;
      if (before === "processing" && m.status !== "processing") parts.push(m.status === "completed" ? `${m.title} is ready.` : `${m.title} could not be made: ${m.error ?? "the renderer failed"}.`);
      seen.current.set(m.id, { status: m.status, title: m.title });
    }
    // One that leaves the list without being deleted here went with its video (deleted for good), or was deleted elsewhere.
    const listed = new Set(data.mixes.map((m) => m.id));
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
        void refetchLibrary();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch, refetchLibrary]);

  const items = data?.mixes ?? [];
  // Any change to what would be mixed is a different start: its own key, and an error about the last one no longer applies.
  function changed() {
    setErr(null);
    setRequestKey(newKey());
  }
  const track = tracks?.find((t) => t.id === trackId);
  const canStart = canEdit === true && data?.available !== false;

  async function search(text = query) {
    const q = text.trim();
    if (q.length < 2) {
      setErr("Describe the music in a few words");
      return;
    }
    setSearching(true);
    setErr(null);
    try {
      const out = await api<{ tracks: MusicTrack[] }>(`/api/music/tracks?query=${encodeURIComponent(q)}`);
      setQuery(q);
      setSearched(q);
      setTracks(out.tracks);
      setTrackId(out.tracks[0]?.id ?? "");
      changed();
      setNote(out.tracks.length ? `${out.tracks.length} tracks for “${q}”; the first is chosen.` : `No tracks for “${q}”; describe it another way.`);
      if (out.tracks.length) focusAfterRender(() => tracksRef.current?.querySelector<HTMLInputElement>("input:checked"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The music could not be searched");
    } finally {
      setSearching(false);
    }
  }

  async function submit() {
    if (!track || !searched) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const body = { videoId, trackId: track.id, query: searched, volume, ...(title.trim() ? { title: title.trim() } : {}) };
      const { mix } = await api<{ mix: Mix }>("/api/music", { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": requestKey } });
      setData((prev) => ({ available: prev?.available ?? true, mixes: [mix, ...(prev?.mixes ?? []).filter((m) => m.id !== mix.id)] }));
      // A check that left before this mix was started would answer without it; asking again retires it.
      void refetch();
      setRequestKey(newKey());
      setTitle("");
      setNote(`Adding “${track.name}” to ${mix.title.replace(/ \(with music\)$/, "")}; it appears here when it is ready.`);
      focusAfterRender(() => listRef.current?.querySelector<HTMLElement>(`[data-mix="${mix.id}"]`) ?? videoRef.current);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The music could not be added");
      // A track the catalog no longer offers needs a new search; the old list is dropped so it is not chosen again.
      if (e instanceof Error && /no longer offered/.test(e.message)) {
        setTracks(null);
        setTrackId("");
      }
      // A refusal is an answer: trying again is a new start. A lost answer keeps its key, so a retry returns the same mix.
      if (isRefusal(e)) setRequestKey(newKey());
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: Mix) {
    if (!window.confirm(`Delete “${m.title}”? Making it again renders it again.`)) return;
    setErr(null);
    setNote(null);
    const next = items[items.indexOf(m) + 1] ?? items[items.indexOf(m) - 1];
    try {
      // Forgotten before the request, so a check landing meanwhile does not announce it as deleted elsewhere.
      seen.current.delete(m.id);
      await api(`/api/music/${m.id}`, { method: "DELETE" });
      setData((prev) => (prev ? { ...prev, mixes: prev.mixes.filter((x) => x.id !== m.id) } : prev));
      void refetch();
      setNote(`Deleted ${m.title}.`);
      focusAfterRender(() => (next ? listRef.current?.querySelector<HTMLElement>(`[data-mix="${next.id}"]`) : headingRef.current));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The video with music could not be deleted");
    }
  }

  return (
    <>
      <SectionTitle title="Music" subtitle="Find a background track by describing it, and mix it under one of your finished videos." />
      {canEdit === false && <ViewOnlyNotice what="add music to videos" />}
      <ErrorBanner message={error} />
      <ErrorBanner message={err} />
      <p role="status" className="sr-only">
        {note ?? ""}
      </p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card className="p-5">
          {data?.available === false ? (
            <p className="text-sm text-slate-600">Background music needs the HeyGen renderer; the current renderer has no such feature.</p>
          ) : (
            <div className="space-y-4">
              <Field label="Library video" hint={!library ? "Loading your videos…" : videos.length ? (library.hasMore ? "Your 200 newest finished videos." : "A finished video of your library.") : "No finished videos yet."}>
                <select ref={videoRef} className={inputClass} value={videoId} disabled={canEdit !== true} onChange={(e) => (setVideoId(e.target.value), changed())}>
                  <option value="">Choose a video</option>
                  {videos.map((v) => (
                    <option key={v.id} value={v.id}>
                      {/* Shape and date tell apart videos of one title (another size, a shot made twice). */}
                      {`${v.title} · ${v.aspect} · ${formatDate(v.createdAt)}`}
                    </option>
                  ))}
                </select>
              </Field>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void search();
                }}
              >
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field label="Describe the music" hint="In plain words: a mood, a style, instruments.">
                      <input className={inputClass} value={query} maxLength={200} disabled={canEdit !== true} onChange={(e) => setQuery(e.target.value)} placeholder="Calm ambient piano for a walkthrough" />
                    </Field>
                  </div>
                  {/* Beside the field rather than in its label, so the field's name is only its own. */}
                  <Button type="submit" variant="secondary" loading={searching} disabled={canEdit !== true} className="mb-5">
                    <Search className="h-4 w-4" /> Search
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" disabled={canEdit !== true || searching} onClick={() => (setQuery(s), void search(s))} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-50">
                      {s}
                    </button>
                  ))}
                </div>
              </form>
              {tracks && tracks.length > 0 && (
                <fieldset ref={tracksRef} data-testid="music-tracks">
                  <legend className="mb-1.5 block text-sm font-medium text-slate-700">Track</legend>
                  <div className="space-y-2">
                    {tracks.map((t) => (
                      <div key={t.id} className={`rounded-lg border p-3 text-sm ${t.id === trackId ? "border-brand-500 bg-brand-50" : "border-slate-200"}`}>
                        <label className="flex items-start gap-2">
                          <input type="radio" name="music-track" className="mt-0.5 accent-brand-600" checked={t.id === trackId} aria-describedby={`track-${t.id}`} onChange={() => (setTrackId(t.id), changed())} />
                          <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{t.name}</span>
                        </label>
                        <span id={`track-${t.id}`} className="ml-6 block text-xs text-slate-500">
                          {t.durationSec > 0 ? `${formatSeconds(Math.round(t.durationSec))} · ` : ""}
                          {t.description ?? "Background music"}
                        </span>
                        {/* Outside the label, so playing it does not choose the track and its controls are not in the track's name. */}
                        <audio controls preload="none" src={t.previewUrl} className="mt-2 h-8 w-full" aria-label={`Hear ${t.name}`} />
                      </div>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">A track shorter than the video plays again from the start until the video ends.</p>
                </fieldset>
              )}
              <fieldset>
                <legend className="mb-1.5 block text-sm font-medium text-slate-700">Music volume</legend>
                <div className="flex flex-wrap gap-4 text-sm text-slate-700">
                  {(Object.keys(MUSIC_VOLUMES) as MusicVolume[]).map((v) => (
                    <label key={v} className="flex items-center gap-2">
                      <input type="radio" name="music-volume" className="accent-brand-600" checked={volume === v} disabled={canEdit !== true} onChange={() => (setVolume(v), changed())} />
                      {VOLUME_LABEL[v]}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-slate-500">Under the speech; Low suits most talking videos.</p>
              </fieldset>
              <Field label="Title (optional)">
                <input className={inputClass} value={title} maxLength={120} disabled={canEdit !== true} onChange={(e) => (setTitle(e.target.value), changed())} placeholder="The video's title, marked with music" />
              </Field>
              <Button onClick={submit} loading={busy} disabled={!videoId || !track || !canStart} className="w-full">
                <Music className="h-4 w-4" /> Add music
              </Button>
              <p className="text-xs text-slate-500">The video with music is not added to the library; download it once it is ready. The music fades in at the start and out at the end.</p>
            </div>
          )}
        </Card>

        <div ref={listRef}>
          <h2 ref={headingRef} tabIndex={-1} className="mb-3 text-sm font-semibold text-slate-900 outline-none">
            Videos with music
          </h2>
          {!data ? null : items.length === 0 ? (
            <EmptyState icon={<Music className="h-8 w-8" />} title="No videos with music yet" body="Choose a video and find a track on the left to get started." />
          ) : (
            <div className="space-y-3">
              {items.map((m) => (
                <Card key={m.id} className="p-4 outline-none focus:ring-2 focus:ring-brand-500" data-testid="mix" data-mix={m.id} tabIndex={-1}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900">{m.title}</div>
                      <div className="mt-0.5 text-xs text-slate-500" data-testid="mix-meta">
                        “{m.trackName}” · {VOLUME_LABEL[m.volume]} volume · {formatDate(m.createdAt)}
                        {m.status === "completed" && typeof m.durationSec === "number" ? ` · ${formatSeconds(Math.max(1, Math.round(m.durationSec)))}` : ""}
                      </div>
                      {m.error && <div className="mt-1 text-xs text-rose-600">{m.error}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={m.status} />
                      {canEdit === true && (
                        <button type="button" onClick={() => remove(m)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" aria-label={`Delete ${mixName(m)}`}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  {m.status === "completed" && m.videoUrl && (
                    <>
                      <video src={m.videoUrl} controls preload="none" className="mt-3 w-full rounded-lg bg-black" aria-label={mixName(m)} />
                      <a href={m.videoUrl} download target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline" aria-label={`Download ${mixName(m)}`}>
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
