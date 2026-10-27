"use client";
import { useEffect, useRef, useState } from "react";
import { Download, Mic2, Trash2, Type, Upload, Wand2 } from "lucide-react";
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

/** As the server keeps it (`MAX_SPEECH_CHARS`). */
const MAX_SPEECH_CHARS = 2000;
/** A fresh key for one start (a UUID where the browser has one, as it does over https and on localhost). */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
const VOICE_STATUS: Record<Voice["status"], string> = { processing: "Being made", completed: "Ready", failed: "Could not be made" };

/** A choice of one of the account's audio clips, with an upload that saves a file as a new clip and chooses it. */
function ClipChoice(props: { label: string; hint: string; uploadLabel: string; clips: AudioClip[]; value: string; disabled: boolean; onChange: (id: string) => void; onUploaded: (clip: AudioClip) => void; onDeleted: (clip: AudioClip) => void; onError: (message: string | null) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const [uploading, setUploading] = useState(false);
  const chosen = props.clips.find((c) => c.id === props.value);
  async function upload(file: File) {
    setUploading(true);
    // A message about an earlier upload no longer applies.
    props.onError(null);
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
  async function remove(clip: AudioClip) {
    if (!window.confirm(`Delete the audio clip “${clip.name}”? Videos, lip syncs, voices, and recordings already made from it are kept, but a scene or draft still using it will need another clip.`)) return;
    props.onError(null);
    try {
      await api(`/api/clips/${clip.id}`, { method: "DELETE" });
      props.onDeleted(clip);
    } catch (e) {
      // One deleted elsewhere is gone all the same.
      if (e instanceof ApiError && e.status === 404) props.onDeleted(clip);
      else return props.onError(e instanceof Error ? e.message : "The audio clip could not be deleted");
    }
    // The delete button goes with the clip; the focus goes to the choice rather than being lost.
    selectRef.current?.focus();
  }
  return (
    <div>
      <Field label={props.label} hint={props.hint}>
        <select ref={selectRef} className={inputClass} value={props.value} disabled={props.disabled || uploading} onChange={(e) => props.onChange(e.target.value)}>
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
        <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => !uploading && fileRef.current?.click()} disabled={props.disabled} loading={uploading} aria-label={`Upload audio for the ${props.label.toLowerCase()}`}>
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
        {/* Clips are made by every upload; one no longer needed can go from here. */}
        {chosen && !props.disabled && (
          <button type="button" onClick={() => void remove(chosen)} disabled={uploading} className="rounded p-1 disabled:opacity-50 text-slate-400 hover:bg-slate-100 hover:text-rose-600" aria-label={`Delete the audio clip ${chosen.name}`}>
            <Trash2 className="h-4 w-4" />
          </button>
        )}
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
  const { data, error, setData, refetch } = useApi<{ voices: Voice[]; changes: Change[]; available: boolean; speech?: boolean }>("/api/voice-changer");
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
  const [speechVoiceId, setSpeechVoiceId] = useState("");
  const [speechText, setSpeechText] = useState("");
  const [speechTitle, setSpeechTitle] = useState("");
  const [speechKey, setSpeechKey] = useState(() => newKey());
  const [speaking, setSpeaking] = useState(false);
  const [voiceName, setVoiceName] = useState("");
  const [sampleId, setSampleId] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [voiceKey, setVoiceKey] = useState(() => newKey());
  const [making, setMaking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Where the message shows: in the card whose action it answers, so it is seen wherever the page is scrolled to.
  const [errAt, setErrAt] = useState<"change" | "speech" | "voice" | "lists">("lists");
  // A message is shown in one card; clearing from a card leaves another card's message (or the lists') alone.
  const fail = (at: typeof errAt) => (message: string | null) => (message === null ? errAt === at && setErr(null) : (setErrAt(at), setErr(message)));
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
  // A clip or voice deleted meanwhile leaves the choices of the card that sent it, so a retry is not refused the same way.
  function forgetGone(e: unknown, at: "change" | "speech" | "voice") {
    if (!(e instanceof Error)) return;
    if (/audio clip is no longer available/.test(e.message)) void refetchClips();
    if (/voice is no longer available/.test(e.message)) {
      if (at === "change") setVoiceId("");
      if (at === "speech") setSpeechVoiceId("");
      void refetch();
    }
  }
  // A chosen clip that leaves the list (deleted here or elsewhere) is no longer chosen.
  useEffect(() => {
    if (!clipData) return;
    const ids = new Set(clipData.clips.map((c) => c.id));
    if (clipId && !ids.has(clipId)) setClipId("");
    if (sampleId && !ids.has(sampleId)) setSampleId("");
  }, [clipData, clipId, sampleId]);
  // Likewise a chosen voice that is no longer ready.
  useEffect(() => {
    if (data && voiceId && !data.voices.some((v) => v.id === voiceId && v.status === "completed")) setVoiceId("");
    if (data && speechVoiceId && !data.voices.some((v) => v.id === speechVoiceId && v.status === "completed")) setSpeechVoiceId("");
  }, [data, voiceId, speechVoiceId]);
  function clipDeleted(clip: AudioClip) {
    setClipData((prev) => (prev ? { clips: prev.clips.filter((c) => c.id !== clip.id) } : prev));
    void refetchClips();
    setNote(`Deleted the audio clip ${clip.name}.`);
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
      fail("change")(e instanceof Error ? e.message : "The recording could not be spoken again");
      forgetGone(e, "change");
      // A refusal is an answer: trying again is a new recording. Anything else (a server error, a start cut off) may
      // still be running, so the key is kept and the list asked again, where a recording still being spoken shows.
      if (isRefusal(e)) setChangeKey(newKey());
      else void refetch();
    } finally {
      setChanging(false);
    }
  }

  async function speakText() {
    setSpeaking(true);
    setErr(null);
    setNote(null);
    try {
      const body = { voiceId: speechVoiceId, text: speechText.trim(), ...(speechTitle.trim() ? { title: speechTitle.trim() } : {}) };
      const { change } = await api<{ change: Change }>("/api/voice-changer/speech", { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": speechKey } });
      setData((prev) => (prev ? { ...prev, changes: [change, ...prev.changes.filter((c) => c.id !== change.id)] } : prev));
      void refetch();
      setSpeechKey(newKey());
      setSpeechTitle("");
      setNote(change.status === "completed" ? `${change.title} is ready.` : `Speaking ${change.title}; it appears here when it is ready.`);
      focusAfterRender(() => changesRef.current?.querySelector<HTMLElement>(`[data-change="${change.id}"]`));
    } catch (e) {
      fail("speech")(e instanceof Error ? e.message : "The text could not be spoken");
      forgetGone(e, "speech");
      if (isRefusal(e)) setSpeechKey(newKey());
      else void refetch();
    } finally {
      setSpeaking(false);
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
      fail("voice")(e instanceof Error ? e.message : "The voice could not be made");
      forgetGone(e, "voice");
      if (isRefusal(e)) setVoiceKey(newKey());
      else void refetch();
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
      // One deleted elsewhere (another tab) is gone all the same.
      if (e instanceof ApiError && e.status === 404) {
        setData((prev) => (prev ? { ...prev, voices: prev.voices.filter((x) => x.id !== v.id) } : prev));
        setNote(`The voice ${v.name} was already deleted.`);
      } else fail("lists")(e instanceof Error ? e.message : "The voice could not be deleted");
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
      if (e instanceof ApiError && e.status === 404) {
        setData((prev) => (prev ? { ...prev, changes: prev.changes.filter((x) => x.id !== c.id) } : prev));
        setNote(`${c.title} was already deleted.`);
      } else fail("lists")(e instanceof Error ? e.message : "The recording could not be deleted");
    }
  }

  const voiceBeingMade = voices.some((v) => v.status === "processing");
  const voiceHint = ready.length ? "One of your instant voices." : voiceBeingMade ? "Your voice is being made; it is ready in a few seconds." : "Make a voice below first.";
  const voicePlaceholder = ready.length ? "Choose a voice" : voiceBeingMade ? "Being made…" : "No voices yet";
  const speechNeeds = !speechVoiceId && !speechText.trim() ? "Choose a voice and write the text to speak it." : !speechVoiceId ? "Choose a voice to speak the text." : !speechText.trim() ? "Write the text to speak." : null;

  return (
    <>
      <SectionTitle title="Voice changer" subtitle="Speak a recording again in another voice, keeping its words and timing." />
      {canEdit === false && <ViewOnlyNotice what="change voices or make new ones" />}
      <ErrorBanner message={error} />
      <ErrorBanner message={errAt === "lists" ? err : null} />
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
              <ErrorBanner message={errAt === "change" ? err : null} />
              <Field label="Voice" hint={voiceHint}>
                <select className={inputClass} value={voiceId} disabled={!editable} onChange={(e) => (setVoiceId(e.target.value), setChangeKey(newKey()), setErr(null))}>
                  <option value="">{voicePlaceholder}</option>
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
                onDeleted={clipDeleted}
                onError={fail("change")}
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
              {editable && (!voiceId || !clipId) && (
                <p id="change-needs" className="text-xs text-slate-500">
                  Choose {!voiceId && !clipId ? "a voice and a recording" : !voiceId ? "a voice" : "a recording"} to change the voice.
                </p>
              )}
              <Button onClick={changeVoice} loading={changing} disabled={!editable || !voiceId || !clipId} className="w-full" aria-describedby={editable && (!voiceId || !clipId) ? "change-needs" : undefined}>
                <Wand2 className="h-4 w-4" /> Change the voice
              </Button>
              <p className="text-xs text-slate-500">HeyGen takes up to a couple of minutes. The result is a WAV to play and download; its link lasts a limited time, so download it soon.</p>
            </Card>

            {data?.speech !== false && (
              <Card className="space-y-4 p-5">
                <h2 className="text-sm font-semibold text-slate-900">Speak text in a voice</h2>
                <ErrorBanner message={errAt === "speech" ? err : null} />
                <Field label="Speaking voice" hint={voiceHint}>
                  <select className={inputClass} value={speechVoiceId} disabled={!editable} onChange={(e) => (setSpeechVoiceId(e.target.value), setSpeechKey(newKey()), errAt === "speech" && setErr(null))}>
                    <option value="">{voicePlaceholder}</option>
                    {ready.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div>
                  <Field label="Text" hint={`Plain prose, up to ${MAX_SPEECH_CHARS.toLocaleString("en-US")} characters; the language is worked out from the text.`}>
                    <textarea className={`${inputClass} min-h-28`} value={speechText} maxLength={MAX_SPEECH_CHARS} disabled={!editable} onChange={(e) => (setSpeechText(e.target.value), setSpeechKey(newKey()), errAt === "speech" && setErr(null))} placeholder="Welcome to the team. Here is what your first week looks like." />
                  </Field>
                  <p className="mt-1 text-right text-xs text-slate-400" aria-hidden>
                    {speechText.length.toLocaleString("en-US")} / {MAX_SPEECH_CHARS.toLocaleString("en-US")}
                  </p>
                </div>
                <Field label="Title for the text (optional)">
                  <input className={inputClass} value={speechTitle} maxLength={120} disabled={!editable} onChange={(e) => (setSpeechTitle(e.target.value), setSpeechKey(newKey()), errAt === "speech" && setErr(null))} placeholder="The text's first words, in the voice" />
                </Field>
                {editable && speechNeeds !== null && (
                  <p id="speech-needs" className="text-xs text-slate-500">
                    {speechNeeds}
                  </p>
            )}
              <Button onClick={speakText} loading={speaking} disabled={!editable || speechNeeds !== null} className="w-full" aria-describedby={editable && speechNeeds !== null ? "speech-needs" : undefined}>
                <Type className="h-4 w-4" /> Speak the text
              </Button>
              <p className="text-xs text-slate-500">Most texts are ready in a few seconds; one not done within a minute is dropped, to try again.</p>
            </Card>
            )}

            <Card className="space-y-4 p-5">
              <h2 className="text-sm font-semibold text-slate-900">Make a voice</h2>
              <ErrorBanner message={errAt === "voice" ? err : null} />
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
                onDeleted={clipDeleted}
                onError={fail("voice")}
              />
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" className="mt-0.5 accent-brand-600" checked={agreed} disabled={!editable} onChange={(e) => setAgreed(e.target.checked)} />
                <span>The person speaking agreed to have their voice cloned, and to it speaking recordings for this account.</span>
              </label>
              {editable && (!voiceName.trim() || !sampleId || !agreed) && (
                <p id="voice-needs" className="text-xs text-slate-500">
                  {[!voiceName.trim() ? "name the voice" : "", !sampleId ? "choose a recording of it" : "", !agreed ? "confirm the speaker agreed" : ""].filter(Boolean).join(", ").replace(/^./, (c) => c.toUpperCase())} to make the voice.
                </p>
              )}
              <Button onClick={makeVoice} loading={making} disabled={!editable || !voiceName.trim() || !sampleId || !agreed} variant="secondary" className="w-full" aria-describedby={editable && (!voiceName.trim() || !sampleId || !agreed) ? "voice-needs" : undefined}>
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
                <EmptyState icon={<Wand2 className="h-8 w-8" />} title="No recordings yet" body="Choose a voice and a recording, or write a text, on the left." />
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
                            {c.text !== undefined ? " · from text" : ""}
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
