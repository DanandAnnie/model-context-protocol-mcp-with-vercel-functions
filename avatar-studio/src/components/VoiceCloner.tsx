"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, Square, Upload } from "lucide-react";
import { Button, Card, ErrorBanner, Field, inputClass } from "@/components/ui";
import { api } from "@/lib/client";
import { VOICE_SAMPLE_SECONDS, joinAsWav } from "@/lib/wav-client";
import type { Voice } from "@/lib/types";

const MAX_SECONDS = 60;
const MAX_SAMPLES = 5;
/** What the samples may weigh in all (they are sent in one request, 4.5 MB at most once encoded). */
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
/** A file joined into one recording is cut at a minute and a half first, so it may be larger (it is only read here). */
const MAX_JOINED_FILE_BYTES = 10 * 1024 * 1024;
const SCRIPT = "Read this in your natural voice: Hi, thanks for stopping by. I'm excited to walk you through what we do and how it can help you. Let's get started.";

/**
 * Record or upload samples and clone a voice with the configured TTS provider. A provider that clones from one recording
 * (`oneRecording`, HeyGen) is sent the samples joined into one WAV, cut at a minute and a half.
 */
export function VoiceCloner({ onCloned, available, oneRecording = false }: { onCloned: (v: Voice) => void; available: boolean; oneRecording?: boolean }) {
  const [name, setName] = useState("");
  const [samples, setSamples] = useState<Array<{ dataUrl: string; label: string; bytes: number }>>([]);
  const [note, setNote] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => stopRecording(), []);

  function toDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Could not read the audio"));
      r.readAsDataURL(blob);
    });
  }

  async function startRecording() {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: "audio/webm" });
        if (blob.size > 0) {
          const dataUrl = await toDataUrl(blob);
          setSamples((s) => (s.length >= MAX_SAMPLES ? s : [...s, { dataUrl, label: `Recording ${s.length + 1}`, bytes: blob.size }]));
        }
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
      setSeconds(0);
      timer.current = setInterval(() => {
        setSeconds((n) => {
          if (n + 1 >= MAX_SECONDS) stopRecording();
          return n + 1;
        });
      }, 1000);
    } catch {
      setErr("Microphone access was refused. You can upload an audio file instead.");
    }
  }

  function stopRecording() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    recorder.current = null;
    setRecording(false);
  }

  async function onFiles(files: FileList | null) {
    if (!files) return;
    setErr(null);
    const picked = Array.from(files);
    // The same file can be picked again after it is removed.
    if (fileRef.current) fileRef.current.value = "";
    let count = samples.length;
    let total = samples.reduce((sum, x) => sum + x.bytes, 0);
    const added: typeof samples = [];
    for (const f of picked) {
      if (count >= MAX_SAMPLES) {
        setErr(`Up to ${MAX_SAMPLES} samples; the rest were left out.`);
        break;
      }
      if (!f.type.startsWith("audio/")) {
        setErr("Only audio files are accepted.");
        continue;
      }
      if (oneRecording ? f.size > MAX_JOINED_FILE_BYTES : total + f.size > MAX_TOTAL_BYTES) {
        setErr(oneRecording ? `“${f.name}” is over 10 MB; use a shorter recording.` : `Samples can be at most 3 MB in total; “${f.name}” would pass that. Use a shorter recording.`);
        continue;
      }
      added.push({ dataUrl: await toDataUrl(f), label: f.name, bytes: f.size });
      count += 1;
      total += f.size;
    }
    if (added.length) setSamples((s) => [...s, ...added].slice(0, MAX_SAMPLES));
  }

  function removeSample(i: number) {
    const next = samples.filter((_, j) => j !== i);
    setSamples(next);
    setNote(`${samples[i].label} removed.`);
    // Focus moves to the sample that took its place, or to the one before, or to Upload when none is left.
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button");
      (buttons?.[Math.min(i, next.length - 1)] ?? uploadRef.current)?.focus();
    });
  }

  async function clone() {
    setBusy(true);
    setErr(null);
    try {
      let sent = samples.map((s) => s.dataUrl);
      if (oneRecording) sent = [(await joinAsWav(await Promise.all(sent.map(async (url) => (await fetch(url)).blob())))).dataUrl];
      const { voice } = await api<{ voice: Voice }>("/api/voices/clone", { method: "POST", body: JSON.stringify({ name, samples: sent }) });
      onCloned(voice);
      setName("");
      setSamples([]);
      setNote(`${voice.name} is cloned and listed with your voices.`);
      // The button is disabled once the form is empty, so focus goes back to the start of the form.
      requestAnimationFrame(() => nameRef.current?.focus());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not clone the voice");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" data-testid="voice-cloner">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Mic className="h-4 w-4 text-slate-400" /> Clone your voice
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Record about a minute of clear speech, or upload one to five audio files ({oneRecording ? "up to 10 MB each" : "3 MB in total"}). The clone is private to your account and usable in every video.
        {oneRecording && ` HeyGen clones from one recording, so the samples are joined in order (the first ${VOICE_SAMPLE_SECONDS} seconds are used).`}
        {!available && " Cloning needs HeyGen or ElevenLabs voices; in demo mode the clone is saved and previews use the browser voice."}
      </p>
      <p role="status" className="sr-only">
        {note}
      </p>
      <ErrorBanner message={err} />
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto]">
        <Field label="Voice name">
          <input ref={nameRef} aria-label="Voice name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dana (my voice)" maxLength={60} className={inputClass} />
        </Field>
        <div className="flex items-end gap-2">
          {recording ? (
            <Button variant="danger" onClick={stopRecording}>
              <Square className="h-4 w-4" /> Stop ({seconds}s)
            </Button>
          ) : (
            <Button variant="secondary" onClick={startRecording} disabled={samples.length >= MAX_SAMPLES}>
              <Mic className="h-4 w-4" /> Record
            </Button>
          )}
          <input ref={fileRef} type="file" accept="audio/*" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
          <Button ref={uploadRef} variant="secondary" onClick={() => fileRef.current?.click()} disabled={samples.length >= MAX_SAMPLES}>
            <Upload className="h-4 w-4" /> Upload
          </Button>
        </div>
      </div>
      <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
        <span className="font-medium text-slate-700">Suggested script: </span>
        {SCRIPT}
      </div>
      {samples.length > 0 && (
        <ul ref={listRef} className="mt-3 flex flex-wrap gap-2" aria-label="Samples">
          {samples.map((s, i) => (
            <li key={i} className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700">
              {s.label}
              <button type="button" onClick={() => removeSample(i)} aria-label={`Remove ${s.label}`} className="text-slate-400 hover:text-rose-700">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end">
        <Button onClick={clone} loading={busy} disabled={!name.trim() || samples.length === 0 || recording}>
          Clone voice
        </Button>
      </div>
    </Card>
  );
}
