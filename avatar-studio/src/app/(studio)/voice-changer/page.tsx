"use client";
import { useEffect, useRef, useState } from "react";
import { Download, Mic2, Trash2, Upload, Wand2 } from "lucide-react";
import { Button, Card, EmptyState, ErrorBanner, Field, SectionTitle, StatusBadge, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { ApiError, api, formatDate, formatSeconds, isRefusal } from "@/lib/client";
import { clipBody } from "@/lib/clip-upload";
import type { AudioClip, InstantVoice, VoiceChange } from "@/lib/types";

/** As the server lists them: never the renderer, its ids, or the upload sent to it. */
type Voice = Omit<InstantVoice, "ownerId" | "provider" | "providerVoiceId">;
type Change = Omit<VoiceChange, "ownerId" | "provider" | "providerVoiceId" | "providerAudio">;
/** A fresh key for one start (a UUID where the browser has one, as it does over https and on localhost). */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
const VOICE_STATUS: Record<Voice["status"], string> = { processing: "Being made", completed: "Ready", failed: "Could not be made" };

/** A choice of one of the account's audio clips, with an upload that saves a file as a new clip and chooses it. */
function ClipChoice(props: { label: string; hint: string; uploadLabel: string; clips: AudioClip[]; value: string; disabled: boolean; onChange: (id: string) => void; onUploaded: (clip: AudioClip) => void; onError: (message: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const chosen = props.clips.find((c) => c.id === props.value);
  async function upload(file: File) {
    setUploading(true);
    try {
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Uploaded audio";
      const { clip } = await api<{ clip: AudioClip }>("/api/clips", { method: "POST", body: JSON.stringify(await clipBody(file, name, "the recording")) });
      props.onUploaded(clip);
    } catch (e) {
      props.onError(e instanceof Error ? e.message : "The audio could not be uploaded");
    } finally {
      setUploading(false);
    }
  }
  return (
    <div>
      <Field label={props.label} hint={props.hint}>
        <select className={inputClass} value={props.value} disabled={props.disabled || uploading} onChange={(e) => props.onChange(e.target.value)}>
          <option value="">{props.clips.length ? "Choose a clip" : "No clips yet"}</option>
          {props.clips.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({formatSeconds(Math.max(1, Math.round(c.durationSec)))})
            </option>
          ))}
        </select>
      </Field>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* Busy, not disabled, while uploading, so the focus stays on it for a keyboard user. */}
        <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => !uploading && fileRef.current?.click()} disabled={props.disabled} loading={uploading}>
          <Upload className="h-3.5 w-3.5" /> Upload audio
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          aria-label={props.uploadLabel}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
        {chosen && <audio controls preload="none" src={`/api/clips/${chosen.id}`} className="h-8 min-w-0 flex-1" aria-label={`Play ${chosen.name}`} />}
      </div>
    </div>
  );
}

/**
 * "Voice changer": a recording spoken again in another voice, the words and timing kept (HeyGen's speech to speech). The
 * voices are instant voices made here from one recording of the person (HeyGen Voice's instant clone), with their
 * agreement; each is the account's own. Recordings are the account's audio clips, uploaded here or saved elsewhere.
 */
export default function VoiceChangerPage() {
  const canEdit = useCanEdit();
  const { data, error, setData, refetch } = useApi<{ voices: Voice[]; changes: Change[]; available: boolean }>("/api/voice-changer");
  const { data: clipData, setData: setClipData, refetch: refetchClips } = useApi<{ clips: AudioClip[] }>("/api/clips");
  const clips = clipData?.clips ?? [];
  const voices = data?.voices ?? [];
  const changes = data?.changes ?? [];
  const ready = voices.filter((v) => v.status === "completed");
  // While a voice or a recording is being made the list is asked again, only while the tab is visible.
  const running = voices.some((v) => v.status === "processing") || changes.some((c) => c.status === "processing");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, 5_000);
    return () => clearInterval(timer);
  }, [running, refetch]);

  const [voiceId, setVoiceId] = useState("");
  const [clipId, setClipId] = useState("");
  const [removeNoise, setRemoveNoise] = useState(false);
  const [title, setTitle] = useState("");
  const [changeKey, setChangeKey] = useState(() => newKey());
  const [changing, setChanging] = useState(false);
  const [voiceName, setVoiceName] = useState("");
  const [sampleId, setSampleId] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [voiceKey, setVoiceKey] = useState(() => newKey());
  const [making, setMaking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const changesRef = useRef<HTMLDivElement>(null);
  const voicesRef = useRef<HTMLUListElement>(null);
  const changesHeading = useRef<HTMLHeadingElement>(null);
  const voicesHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterRender = useFocusAfterRender();

  // A voice or recording that finishes or fails while the page is open is announced.
  const seen = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!data) return;
    const parts: string[] = [];
    for (const v of data.voices) {
      if (seen.current.get(v.id) === "processing" && v.status !== "processing") parts.push(v.status === "completed" ? `The voice ${v.name} is ready.` : `The voice ${v.name} could not be made: ${v.error ?? "the renderer failed"}.`);
      seen.current.set(v.id, v.status);
    }
    for (const c of data.changes) {
      if (seen.current.get(c.id) === "processing" && c.status !== "processing") parts.push(c.status === "completed" ? `${c.title} is ready.` : `${c.title} could not be made: ${c.error ?? "the renderer failed"}.`);
      seen.current.set(c.id, c.status);
    }
    if (parts.length) setNote(parts.join(" "));
  }, [data]);

  const editable = canEdit === true && data?.available !== false;
  function uploaded(clip: AudioClip) {
    setClipData((prev) => ({ clips: [clip, ...(prev?.clips ?? []).filter((c) => c.id !== clip.id)] }));
    // A first listing still on its way would land without the new clip; asking again retires it.
    void refetchClips();
    setNote(`Uploaded ${clip.name}.`);
  }
  // A clip deleted meanwhile leaves the choices, so a retry is not refused the same way.
  function forgetGoneClip(e: unknown) {
    if (e instanceof Error && /audio clip is no longer available/.test(e.message)) void refetchClips();
  }

  async function changeVoice() {
    setChanging(true);
    setErr(null);
    setNote(null);
    try {
      const body = { voiceId, clipId, removeNoise, ...(title.trim() ? { title: title.trim() } : {}) };
      const { change } = await api<{ change: Change }>("/api/voice-changer/changes", { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": changeKey } });
      setData((prev) => (prev ? { ...prev, changes: [change, ...prev.changes.filter((c) => c.id !== change.id)] } : prev));
      void refetch();
      setChangeKey(newKey());
      setTitle("");
      setNote(change.status === "completed" ? `${change.title} is ready.` : `Speaking ${change.title}; it appears here when it is ready.`);
      focusAfterRender(() => changesRef.current?.querySelector<HTMLElement>(`[data-change="${change.id}"]`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The recording could not be spoken again");
      forgetGoneClip(e);
      if (isRefusal(e) || (e instanceof ApiError && e.status >= 500 && e.status !== 504)) setChangeKey(newKey());
    } finally {
      setChanging(false);
    }
  }

  async function makeVoice() {
    setMaking(true);
    setErr(null);
    setNote(null);
    try {
      const { voice } = await api<{ voice: Voice }>("/api/voice-changer/voices", { method: "POST", body: JSON.stringify({ name: voiceName.trim(), clipId: sampleId, agreed }), headers: { "Idempotency-Key": voiceKey } });
      setData((prev) => (prev ? { ...prev, voices: [voice, ...prev.voices.filter((v) => v.id !== voice.id)] } : prev));
      void refetch();
      setVoiceKey(newKey());
      setVoiceName("");
      setAgreed(false);
      setNote(`Making the voice ${voice.name}; it is ready in a few seconds.`);
      focusAfterRender(() => voicesRef.current?.querySelector<HTMLElement>(`[data-voice="${voice.id}"]`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The voice could not be made");
      forgetGoneClip(e);
      if (isRefusal(e)) setVoiceKey(newKey());
    } finally {
      setMaking(false);
    }
  }

  async function removeVoice(v: Voice) {
    if (!window.confirm(`Delete the voice “${v.name}”? It is deleted at HeyGen too; recordings already spoken in it are kept.`)) return;
    setErr(null);
    const next = voices[voices.indexOf(v) + 1] ?? voices[voices.indexOf(v) - 1];
    try {
      seen.current.delete(v.id);
      await api(`/api/voice-changer/voices/${v.id}`, { method: "DELETE" });
      setData((prev) => (prev ? { ...prev, voices: prev.voices.filter((x) => x.id !== v.id) } : prev));
      if (voiceId === v.id) setVoiceId("");
      setNote(`Deleted the voice ${v.name}.`);
      focusAfterRender(() => (next ? voicesRef.current?.querySelector<HTMLElement>(`[data-voice="${next.id}"]`) : voicesHeading.current));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The voice could not be deleted");
    }
  }

  async function removeChange(c: Change) {
    if (!window.confirm(`Delete “${c.title}”? Making it again speaks it again.`)) return;
    setErr(null);
    const next = changes[changes.indexOf(c) + 1] ?? changes[changes.indexOf(c) - 1];
    try {
      seen.current.delete(c.id);
      await api(`/api/voice-changer/changes/${c.id}`, { method: "DELETE" });
      setData((prev) => (prev ? { ...prev, changes: prev.changes.filter((x) => x.id !== c.id) } : prev));
      setNote(`Deleted ${c.title}.`);
      focusAfterRender(() => (next ? changesRef.current?.querySelector<HTMLElement>(`[data-change="${next.id}"]`) : changesHeading.current));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The recording could not be deleted");
    }
  }

  return (
    <>
      <SectionTitle title="Voice changer" subtitle="Speak a recording again in another voice, keeping its words and timing." />
      {canEdit === false && <ViewOnlyNotice what="change voices or make new ones" />}
      <ErrorBanner message={error} />
      <ErrorBanner message={err} />
      <p role="status" className="sr-only">
        {note ?? ""}
      </p>
      {data?.available === false ? (
        <Card className="p-5">
          <p className="text-sm text-slate-600">The voice changer needs the HeyGen renderer; the current renderer has no such feature.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.2fr]">
          <div className="space-y-6">
            <Card className="space-y-4 p-5">
              <h2 className="text-sm font-semibold text-slate-900">Change a recording&apos;s voice</h2>
              <Field label="Voice" hint={ready.length ? "One of your instant voices." : "Make a voice below first."}>
                <select className={inputClass} value={voiceId} disabled={!editable} onChange={(e) => (setVoiceId(e.target.value), setChangeKey(newKey()), setErr(null))}>
                  <option value="">{ready.length ? "Choose a voice" : "No voices yet"}</option>
                  {ready.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </Field>
              <ClipChoice
                label="Recording"
                hint="One of your audio clips, or upload a recording (up to 90 seconds)."
                uploadLabel="Upload the recording to change"
                clips={clips}
                value={clipId}
                disabled={!editable}
                onChange={(id) => (setClipId(id), setChangeKey(newKey()), setErr(null))}
                onUploaded={(clip) => (uploaded(clip), setClipId(clip.id), setChangeKey(newKey()))}
                onError={setErr}
              />
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" className="mt-0.5 accent-brand-600" checked={removeNoise} disabled={!editable} onChange={(e) => (setRemoveNoise(e.target.checked), setChangeKey(newKey()))} />
                <span>
                  Clean up background noise first
                  <span className="block text-xs text-slate-500">Takes a little longer.</span>
                </span>
              </label>
              <Field label="Title (optional)">
                <input className={inputClass} value={title} maxLength={120} disabled={!editable} onChange={(e) => (setTitle(e.target.value), setChangeKey(newKey()))} placeholder="The recording's name, in the voice" />
              </Field>
              <Button onClick={changeVoice} loading={changing} disabled={!editable || !voiceId || !clipId} className="w-full">
                <Wand2 className="h-4 w-4" /> Change the voice
              </Button>
              <p className="text-xs text-slate-500">HeyGen takes up to a couple of minutes. The result is a WAV to play and download; its link lasts a limited time, so download it soon.</p>
            </Card>

            <Card className="space-y-4 p-5">
              <h2 className="text-sm font-semibold text-slate-900">Make a voice</h2>
              <Field label="Voice name">
                <input className={inputClass} value={voiceName} maxLength={60} disabled={!editable} onChange={(e) => (setVoiceName(e.target.value), setVoiceKey(newKey()))} placeholder="Narrator" />
              </Field>
              <ClipChoice
                label="Recording of the voice"
                hint="One person speaking clearly, ideally a minute or more; background noise is removed."
                uploadLabel="Upload a recording of the voice"
                clips={clips}
                value={sampleId}
                disabled={!editable}
                onChange={(id) => (setSampleId(id), setVoiceKey(newKey()), setErr(null))}
                onUploaded={(clip) => (uploaded(clip), setSampleId(clip.id), setVoiceKey(newKey()))}
                onError={setErr}
              />
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" className="mt-0.5 accent-brand-600" checked={agreed} disabled={!editable} onChange={(e) => setAgreed(e.target.checked)} />
                <span>The person speaking agreed to have their voice cloned, and to it speaking recordings for this account.</span>
              </label>
              <Button onClick={makeVoice} loading={making} disabled={!editable || !voiceName.trim() || !sampleId || !agreed} variant="secondary" className="w-full">
                <Mic2 className="h-4 w-4" /> Make the voice
              </Button>
            </Card>
          </div>

          <div className="space-y-6">
            <section>
              <h2 ref={voicesHeading} tabIndex={-1} className="mb-3 text-sm font-semibold text-slate-900 outline-none">
                Your voices
              </h2>
              {!data ? null : voices.length === 0 ? (
                <p className="text-sm text-slate-500">No instant voices yet.</p>
              ) : (
                <ul ref={voicesRef} className="space-y-2" data-testid="instant-voices">
                  {voices.map((v) => (
                    <li key={v.id} data-voice={v.id} tabIndex={-1} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-900">{v.name}</div>
                        <div className="text-xs text-slate-500">
                          {VOICE_STATUS[v.status]} · {formatDate(v.createdAt)}
                          {v.error ? ` · ${v.error}` : ""}
                        </div>
                      </div>
                      {canEdit === true && (
                        <button type="button" onClick={() => removeVoice(v)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" aria-label={`Delete the voice ${v.name}`}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section ref={changesRef}>
              <h2 ref={changesHeading} tabIndex={-1} className="mb-3 text-sm font-semibold text-slate-900 outline-none">
                Recordings in other voices
              </h2>
              {!data ? null : changes.length === 0 ? (
                <EmptyState icon={<Wand2 className="h-8 w-8" />} title="No recordings yet" body="Choose a voice and a recording on the left." />
              ) : (
                <div className="space-y-3">
                  {changes.map((c) => (
                    <Card key={c.id} className="p-4 outline-none focus:ring-2 focus:ring-brand-500" data-testid="voice-change" data-change={c.id} tabIndex={-1}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900">{c.title}</div>
                          <div className="mt-0.5 text-xs text-slate-500" data-testid="voice-change-meta">
                            In “{c.voiceName}” · {formatDate(c.createdAt)}
                            {typeof c.durationSec === "number" && c.durationSec > 0 ? ` · ${formatSeconds(Math.max(1, Math.round(c.durationSec)))}` : ""}
                            {c.removeNoise ? " · noise removed" : ""}
                          </div>
                          {c.error && <div className="mt-1 text-xs text-rose-600">{c.error}</div>}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <StatusBadge status={c.status} />
                          {canEdit === true && (
                            <button type="button" onClick={() => removeChange(c)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" aria-label={`Delete ${c.title}, ${formatDate(c.createdAt)}`}>
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </div>
                      {c.status === "completed" && c.audioUrl && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <audio controls preload="none" src={c.audioUrl} className="h-8 min-w-0 flex-1" aria-label={`Play ${c.title}`} />
                          <a href={c.audioUrl} download target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline" aria-label={`Download ${c.title}, ${formatDate(c.createdAt)}`}>
                            <Download className="h-3 w-3" aria-hidden /> Download
                          </a>
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}
