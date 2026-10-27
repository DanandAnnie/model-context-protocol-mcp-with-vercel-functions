"use client";
import { useEffect, useRef, useState } from "react";
import { AudioLines, Download, Trash2, Upload } from "lucide-react";
import { Button, Card, EmptyState, ErrorBanner, Field, SectionTitle, StatusBadge, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { api, formatDate, formatSeconds, isRefusal } from "@/lib/client";
import { clipBody as clipFrom } from "@/lib/clip-upload";
import { VOICE_RESULT_LINK_MS, type AudioClip, type LipsyncJob, type LipsyncMode, type Video, type VoiceChange } from "@/lib/types";

/** A recording or text spoken in one of the account's instant voices, as the voice changer lists it. */
type Voiced = Pick<VoiceChange, "id" | "title" | "status" | "audioUrl" | "durationSec" | "updatedAt" | "checkedAt">;
/** A lip sync as the server lists it: never the renderer or its job id. */
type Lipsync = Omit<LipsyncJob, "ownerId" | "provider" | "providerJobId">;
/** A fresh key for one start (a UUID where the browser has one, as it does over https and on localhost). */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
/** Lip-synced videos' links are renewed by the server once this old; a page left open asks again when it is looked at. */
const RELINK_MS = 30 * 60 * 1000;
const MODE_LABEL: Record<LipsyncMode, string> = { speed: "Fast", precision: "Precise" };
/**
 * "Lip sync": a video given a new audio track, the speaker's mouth redrawn to match (HeyGen lip sync). For a line
 * re-recorded after the shoot, a voice-over replaced, or a dub of one's own. The footage is a video of the library or a
 * link; the audio is a saved audio clip (uploaded here or recorded for a scene), a recording or text spoken in one of the
 * account's instant voices (`?voiceChange=` chooses one, from the voice changer), or a link.
 */
export default function LipsyncPage() {
  const canEdit = useCanEdit();
  const { data, error, setData, refetch } = useApi<{ lipsyncs: Lipsync[]; available: boolean }>("/api/lipsyncs");
  // While a lip sync runs the list is asked again, only while the tab is visible, and a failed check does not stop the next one.
  const running = (data?.lipsyncs ?? []).some((l) => l.status === "processing");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 10_000);
    return () => clearInterval(timer);
  }, [running, refetch]);
  const { data: library } = useApi<{ videos: Video[]; hasMore?: boolean }>("/api/videos?status=completed&limit=200");
  const videos = (library?.videos ?? []).filter((v) => v.videoUrl && !v.deletedAt);
  const { data: clipData, setData: setClipData, refetch: refetchClips } = useApi<{ clips: AudioClip[] }>("/api/clips");
  const clips = clipData?.clips ?? [];
  // Drawn again each minute, so a recording leaves the choices once it is over an hour old.
  const [, setMinute] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setMinute((m) => m + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const { data: voiceData, error: voiceError, refetch: refetchVoices } = useApi<{ changes: Voiced[] }>("/api/voice-changer");
  // Ready ones whose link from the renderer is still good (the server refuses the others).
  const voiced = (voiceData?.changes ?? []).filter((c) => c.status === "completed" && c.audioUrl && Date.now() - Date.parse(c.checkedAt ?? c.updatedAt) <= VOICE_RESULT_LINK_MS);
  const [from, setFrom] = useState<"link" | "library">("library");
  const [sourceUrl, setSourceUrl] = useState("");
  const [videoId, setVideoId] = useState("");
  const [audioFrom, setAudioFrom] = useState<"clip" | "link" | "voice">("clip");
  const [voiceChangeId, setVoiceChangeId] = useState("");
  // Why a recording chosen by the link, or chosen before, is no longer chosen; shown under the choice.
  const [voiceGone, setVoiceGone] = useState<string | null>(null);
  // Sent here from the voice changer with one of its recordings chosen.
  useEffect(() => {
    const chosen = new URLSearchParams(window.location.search).get("voiceChange");
    if (chosen && /^vc_[A-Za-z0-9_-]{1,64}$/.test(chosen)) {
      setAudioFrom("voice");
      setVoiceChangeId(chosen);
    }
    // Read once: a reload after a start does not choose it again (the rest of the address is kept).
    if (chosen) {
      const url = new URL(window.location.href);
      url.searchParams.delete("voiceChange");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);
  // A chosen recording not on offer (deleted, another account's, or too old to send) is not chosen, and the page says so.
  useEffect(() => {
    if (audioFrom !== "voice" || !voiceData || !voiceChangeId || voiced.some((c) => c.id === voiceChangeId)) return;
    const why = "That recording is no longer available, or was made over an hour ago; make it again in the voice changer.";
    setVoiceChangeId("");
    setVoiceGone(why);
    // Announced too: the note under the choice is only read with the choice.
    setNote(why);
  }, [audioFrom, voiceData, voiceChangeId, voiced]);
  const [clipId, setClipId] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [mode, setMode] = useState<LipsyncMode>("speed");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // One key per start: a retry of the same start (after a timeout, say) sends it again and gets the same lip sync back.
  const [requestKey, setRequestKey] = useState(() => newKey());
  const fileRef = useRef<HTMLInputElement>(null);
  const firstInput = useRef<HTMLSelectElement & HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterRender = useFocusAfterRender();
  // A lip sync that finishes or fails while the page is open is announced.
  const seen = useRef<Map<string, { status: Lipsync["status"]; title: string }>>(new Map());
  useEffect(() => {
    if (!data) return;
    const parts: string[] = [];
    for (const l of data.lipsyncs) {
      const before = seen.current.get(l.id)?.status;
      if (before === "processing" && l.status !== "processing") parts.push(l.status === "completed" ? `${l.title} is ready.` : `${l.title} could not be lip-synced: ${l.error ?? "the renderer failed"}.`);
      seen.current.set(l.id, { status: l.status, title: l.title });
    }
    // One that leaves the list without being deleted here went with its video (deleted for good), or was deleted elsewhere.
    const listed = new Set(data.lipsyncs.map((l) => l.id));
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

  const items = data?.lipsyncs ?? [];
  // Any change to what would be synced is a different start: its own key, and an error about the last one no longer applies.
  function changed() {
    setErr(null);
    setRequestKey(newKey());
  }
  const videoReady = from === "link" ? /^https:\/\/\S+$/i.test(sourceUrl.trim()) : !!videoId;
  const audioReady = audioFrom === "link" ? /^https:\/\/\S+$/i.test(audioUrl.trim()) : audioFrom === "voice" ? voiced.some((c) => c.id === voiceChangeId) : !!clipId;
  const canStart = canEdit !== false && data?.available !== false;

  async function upload(file: File) {
    setUploading(true);
    setErr(null);
    try {
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Uploaded audio";
      const { clip } = await api<{ clip: AudioClip }>("/api/clips", { method: "POST", body: JSON.stringify(await clipFrom(file, name, "the new audio", "trim it, or paste a link to the full track")) });
      setClipData((prev) => ({ clips: [clip, ...(prev?.clips ?? []).filter((c) => c.id !== clip.id)] }));
      // A first listing still on its way would land without the new clip; asking again retires it.
      void refetchClips();
      setClipId(clip.id);
      changed();
      setNote(`Uploaded ${clip.name}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The audio could not be uploaded");
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const body = {
        ...(from === "link" ? { sourceUrl: sourceUrl.trim() } : { videoId }),
        ...(audioFrom === "link" ? { audioUrl: audioUrl.trim() } : audioFrom === "voice" ? { voiceChangeId } : { clipId }),
        mode,
        ...(title.trim() ? { title: title.trim() } : {}),
      };
      const { lipsync } = await api<{ lipsync: Lipsync }>("/api/lipsyncs", { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": requestKey } });
      setData((prev) => ({ available: prev?.available ?? true, lipsyncs: [lipsync, ...(prev?.lipsyncs ?? []).filter((l) => l.id !== lipsync.id)] }));
      // A check that left before this lip sync was started would answer without it; asking again retires it.
      void refetch();
      setRequestKey(newKey());
      setSourceUrl("");
      setVideoId("");
      setAudioUrl("");
      setClipId("");
      setVoiceChangeId("");
      setVoiceGone(null);
      setTitle("");
      setNote(`Lip-syncing ${lipsync.title}; it appears here when it is ready.`);
      // Focus goes to the new lip sync, rather than being lost with the cleared form.
      focusAfterRender(() => listRef.current?.querySelector<HTMLElement>(`[data-lipsync="${lipsync.id}"]`) ?? firstInput.current);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The video could not be lip-synced");
      // A clip deleted meanwhile leaves the list and the choice, so a retry is not refused the same way.
      if (e instanceof Error && /audio clip is no longer available/.test(e.message)) {
        setClipId("");
        void refetchClips();
      }
      // A recording gone or too old to send is no longer chosen; the list is asked again so it leaves the choices too.
      if (e instanceof Error && /^That recording in another voice is no longer available|^“.*” was made (?:by another renderer|over an hour ago)/.test(e.message)) {
        setVoiceChangeId("");
        void refetchVoices();
      }
      // A refusal is an answer: trying again (after topping up, say) is a new start. A lost answer, or one HeyGen is still
      // working on, keeps its key, so a retry returns the start that may have gone through.
      if (isRefusal(e)) setRequestKey(newKey());
    } finally {
      setBusy(false);
    }
  }

  async function remove(l: Lipsync) {
    if (!window.confirm(`Delete “${l.title}”? Making it again uses another job.`)) return;
    setErr(null);
    setNote(null);
    const next = items[items.indexOf(l) + 1] ?? items[items.indexOf(l) - 1];
    try {
      // Forgotten before the request, so a check landing meanwhile does not announce it as deleted elsewhere.
      seen.current.delete(l.id);
      await api(`/api/lipsyncs/${l.id}`, { method: "DELETE" });
      setData((prev) => (prev ? { ...prev, lipsyncs: prev.lipsyncs.filter((x) => x.id !== l.id) } : prev));
      void refetch();
      setNote(`Deleted ${l.title}.`);
      // Focus moves to the next lip sync, or to the list's heading, rather than being lost with the button.
      focusAfterRender(() => (next ? listRef.current?.querySelector<HTMLElement>(`[data-lipsync="${next.id}"]`) : headingRef.current));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The lip sync could not be deleted");
    }
  }

  const clipName = (id?: string) => clips.find((c) => c.id === id)?.name;

  return (
    <>
      <SectionTitle title="Lip sync" subtitle="Put new audio on a video, a line re-recorded or a voice-over replaced, and the speaker's mouth is redrawn to match." />
      {canEdit === false && <ViewOnlyNotice what="lip-sync videos" />}
      {/* A failed list load and a refused start are both shown; neither hides the other. */}
      <ErrorBanner message={error} />
      <ErrorBanner message={err} />
      <p role="status" className="sr-only">
        {note ?? ""}
      </p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card className="p-5">
          {data?.available === false ? (
            <p className="text-sm text-slate-600">Lip sync needs the HeyGen renderer; the current renderer has no such feature.</p>
          ) : (
            <div className="space-y-4">
              <fieldset>
                <legend className="mb-1.5 block text-sm font-medium text-slate-700">Video</legend>
                <div className="flex flex-wrap gap-4 text-sm text-slate-700">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="lipsync-from" className="accent-brand-600" checked={from === "library"} disabled={canEdit === false} onChange={() => (setFrom("library"), changed())} />
                    One of my videos
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="lipsync-from" className="accent-brand-600" checked={from === "link"} disabled={canEdit === false} onChange={() => (setFrom("link"), changed())} />
                    A link
                  </label>
                </div>
              </fieldset>
              {from === "link" ? (
                <Field label="Video URL" hint="A public https link to a video of one person speaking, face to camera.">
                  <input ref={firstInput} type="url" inputMode="url" className={inputClass} value={sourceUrl} disabled={canEdit === false} onChange={(e) => (setSourceUrl(e.target.value), changed())} placeholder="https://…/interview.mp4" />
                </Field>
              ) : (
                <Field label="Library video" hint={!library ? "Loading your videos…" : videos.length ? (library.hasMore ? "Your 200 newest finished videos." : "A finished video of your library.") : "No finished videos yet."}>
                  <select ref={firstInput} className={inputClass} value={videoId} disabled={canEdit === false} onChange={(e) => (setVideoId(e.target.value), changed())}>
                    <option value="">Choose a video</option>
                    {videos.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.title}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <fieldset>
                <legend className="mb-1.5 block text-sm font-medium text-slate-700">New audio</legend>
                <div className="flex flex-wrap gap-4 text-sm text-slate-700">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="lipsync-audio" className="accent-brand-600" checked={audioFrom === "clip"} disabled={canEdit === false} onChange={() => (setAudioFrom("clip"), changed())} />
                    An audio clip
                  </label>
                  {(voiced.length > 0 || audioFrom === "voice") && (
                    <label className="flex items-center gap-2">
                      <input type="radio" name="lipsync-audio" className="accent-brand-600" checked={audioFrom === "voice"} disabled={canEdit === false} onChange={() => (setAudioFrom("voice"), setVoiceGone(null), changed())} />
                      In one of my voices
                    </label>
                  )}
                  <label className="flex items-center gap-2">
                    <input type="radio" name="lipsync-audio" className="accent-brand-600" checked={audioFrom === "link"} disabled={canEdit === false} onChange={() => (setAudioFrom("link"), changed())} />
                    A link
                  </label>
                </div>
              </fieldset>
              {audioFrom === "voice" ? (
                <div>
                  <Field label="Recording in your voice" hint={voiced.length ? "A recording or text spoken in one of your instant voices within the last hour, from the voice changer." : voiceData ? "None made within the last hour is ready; make one in the voice changer." : voiceError ? "Your recordings could not be loaded." : "Loading your recordings…"}>
                    <select className={inputClass} value={voiceChangeId} disabled={canEdit === false} aria-describedby={voiceGone ? "voice-gone" : undefined} onChange={(e) => (setVoiceChangeId(e.target.value), setVoiceGone(null), changed())}>
                      <option value="">{voiced.length ? "Choose a recording" : "No recordings yet"}</option>
                      {voiced.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                          {typeof c.durationSec === "number" && c.durationSec > 0 ? ` (${formatSeconds(Math.max(1, Math.round(c.durationSec)))})` : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {voiceGone && (
                    <p id="voice-gone" className="mt-1 text-xs text-amber-700">
                      {voiceGone}
                    </p>
                  )}
                </div>
              ) : audioFrom === "link" ? (
                <Field label="Audio URL" hint="A public https link to an MP3 or WAV file with the new speech.">
                  <input type="url" inputMode="url" className={inputClass} value={audioUrl} disabled={canEdit === false} onChange={(e) => (setAudioUrl(e.target.value), changed())} placeholder="https://…/new-voice-over.mp3" />
                </Field>
              ) : (
                <div>
                  <Field label="Audio clip" hint={clips.length ? "Your saved clips, including those recorded for a scene; or upload one (up to 90 seconds). An MP3 is kept as it is; other files are saved as 16 kHz mono WAV." : "Upload an audio file (up to 90 seconds); it is saved with your audio clips. An MP3 is kept as it is; other files are saved as 16 kHz mono WAV."}>
                    <select className={inputClass} value={clipId} disabled={canEdit === false || uploading} onChange={(e) => (setClipId(e.target.value), changed())}>
                      <option value="">{clips.length ? "Choose a clip" : "No clips yet"}</option>
                      {clips.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({formatSeconds(Math.max(1, Math.round(c.durationSec)))})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {/* Busy, not disabled, while uploading, so the focus stays on it for a keyboard user. */}
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => !uploading && fileRef.current?.click()} disabled={canEdit === false} loading={uploading}>
                      <Upload className="h-3.5 w-3.5" /> Upload audio
                    </Button>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      aria-label="Upload the new audio"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) void upload(file);
                      }}
                    />
                    {clipId && <audio controls preload="none" src={`/api/clips/${clipId}`} className="h-8 min-w-0 flex-1" aria-label={`Play ${clipName(clipId) ?? "the clip"}`} />}
                  </div>
                </div>
              )}
              <fieldset>
                <legend className="mb-1.5 block text-sm font-medium text-slate-700">Quality</legend>
                <div className="space-y-1.5 text-sm text-slate-700">
                  <label className="flex items-start gap-2">
                    <input type="radio" name="lipsync-mode" className="mt-0.5 accent-brand-600" checked={mode === "speed"} disabled={canEdit === false} onChange={() => (setMode("speed"), changed())} />
                    <span>
                      Fast <span className="text-xs text-slate-500">· a quick resync, good for drafts</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input type="radio" name="lipsync-mode" className="mt-0.5 accent-brand-600" checked={mode === "precision"} disabled={canEdit === false} onChange={() => (setMode("precision"), changed())} />
                    <span>
                      Precise <span className="text-xs text-slate-500">· slower, truer mouth movements for the final cut</span>
                    </span>
                  </label>
                </div>
              </fieldset>
              <Field label="Title (optional)">
                <input className={inputClass} value={title} maxLength={120} disabled={canEdit === false} onChange={(e) => setTitle(e.target.value)} placeholder={from === "library" ? "The video's title, marked lip-synced" : "Lip-synced video"} />
              </Field>
              <Button onClick={submit} loading={busy} disabled={!videoReady || !audioReady || uploading || !canStart} className="w-full">
                <AudioLines className="h-4 w-4" /> Lip-sync video
              </Button>
              <p className="text-xs text-slate-500">The lip-synced video is not added to the library; download it once it is ready. When the new audio is longer or shorter, the video is stretched to fit it.</p>
            </div>
          )}
        </Card>

        <div ref={listRef}>
          <h2 ref={headingRef} tabIndex={-1} className="mb-3 text-sm font-semibold text-slate-900 outline-none">
            Lip-synced videos
          </h2>
          {!data ? null : items.length === 0 ? (
            <EmptyState icon={<AudioLines className="h-8 w-8" />} title="No lip-synced videos yet" body="Choose a video and its new audio on the left to get started." />
          ) : (
            <div className="space-y-3">
              {items.map((l) => (
                <Card key={l.id} className="p-4 outline-none focus:ring-2 focus:ring-brand-500" data-testid="lipsync" data-lipsync={l.id} tabIndex={-1}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900">{l.title}</div>
                      <div className="mt-0.5 break-words text-xs text-slate-500" data-testid="lipsync-meta">
                        {l.videoId ? "A library video" : "A linked video"} · {l.voiceChangeId ? `“${l.audioName ?? "a recording"}” in your voice` : l.clipId ? (clipName(l.clipId) ? `audio clip “${clipName(l.clipId)}”` : "an audio clip") : "linked audio"} · {MODE_LABEL[l.mode]} · {formatDate(l.createdAt)}
                        {l.status === "completed" && typeof l.durationSec === "number" ? ` · ${formatSeconds(Math.max(1, Math.round(l.durationSec)))}` : ""}
                      </div>
                      {l.error && <div className="mt-1 text-xs text-rose-600">{l.error}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={l.status} />
                      {canEdit !== false && (
                        <button type="button" onClick={() => remove(l)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" aria-label={`Delete ${l.title}`}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  {l.status === "completed" && l.videoUrl && (
                    <>
                      <video src={l.videoUrl} controls preload="none" className="mt-3 w-full rounded-lg bg-black" aria-label={l.title} />
                      <a href={l.videoUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline" aria-label={`Download ${l.title}`}>
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
