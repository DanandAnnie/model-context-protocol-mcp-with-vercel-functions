"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, Square, Upload } from "lucide-react";
import { Button, Card, ErrorBanner, Field, inputClass } from "@/components/ui";
import { api } from "@/lib/client";
import type { Voice } from "@/lib/types";

const MAX_SECONDS = 60;
const SCRIPT = "Read this in your natural voice: Hi, thanks for stopping by. I'm excited to walk you through what we do and how it can help you. Let's get started.";

/** Record or upload samples and clone a voice with the configured TTS provider. */
export function VoiceCloner({ onCloned, available }: { onCloned: (v: Voice) => void; available: boolean }) {
  const [name, setName] = useState("");
  const [samples, setSamples] = useState<Array<{ dataUrl: string; label: string }>>([]);
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
          setSamples((s) => [...s, { dataUrl, label: `Recording ${s.length + 1}` }]);
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
    for (const f of Array.from(files).slice(0, 5)) {
      if (!f.type.startsWith("audio/")) {
        setErr("Only audio files are accepted.");
        continue;
      }
      if (f.size > 10 * 1024 * 1024) {
        setErr("Each file must be under 10 MB.");
        continue;
      }
      const dataUrl = await toDataUrl(f);
      setSamples((s) => [...s, { dataUrl, label: f.name }]);
    }
  }

  async function clone() {
    setBusy(true);
    setErr(null);
    try {
      const { voice } = await api<{ voice: Voice }>("/api/voices/clone", { method: "POST", body: JSON.stringify({ name, samples: samples.map((s) => s.dataUrl) }) });
      onCloned(voice);
      setName("");
      setSamples([]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not clone the voice");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" data-testid="voice-cloner">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Mic className="h-4 w-4 text-slate-400" /> Clone your voice
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Record about a minute of clear speech, or upload one to five audio files (10 MB total). The clone is private to your account and usable in every video.
        {!available && " Cloning needs TTS_PROVIDER=elevenlabs; in demo mode the clone is saved and previews use the browser voice."}
      </p>
      <ErrorBanner message={err} />
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto]">
        <Field label="Voice name">
          <input aria-label="Voice name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dana (my voice)" maxLength={60} className={inputClass} />
        </Field>
        <div className="flex items-end gap-2">
          {recording ? (
            <Button variant="danger" onClick={stopRecording}>
              <Square className="h-4 w-4" /> Stop ({seconds}s)
            </Button>
          ) : (
            <Button variant="secondary" onClick={startRecording} disabled={samples.length >= 5}>
              <Mic className="h-4 w-4" /> Record
            </Button>
          )}
          <input ref={fileRef} type="file" accept="audio/*" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
          <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={samples.length >= 5}>
            <Upload className="h-4 w-4" /> Upload
          </Button>
        </div>
      </div>
      <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
        <span className="font-medium text-slate-700">Suggested script: </span>
        {SCRIPT}
      </div>
      {samples.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Samples">
          {samples.map((s, i) => (
            <li key={i} className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700">
              {s.label}
              <button type="button" onClick={() => setSamples((all) => all.filter((_, j) => j !== i))} aria-label={`Remove ${s.label}`} className="text-slate-400 hover:text-rose-700">
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
