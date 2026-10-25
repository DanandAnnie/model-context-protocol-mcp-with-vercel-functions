"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, Square, Upload, X } from "lucide-react";
import { Button, ErrorBanner, inputClass } from "@/components/ui";
import { api, formatSeconds } from "@/lib/client";
import { toWavDataUrl } from "@/lib/wav-client";
import type { AudioClip } from "@/lib/types";

/** Longest recording, matching the server's clip limit. */
const MAX_RECORD_SECONDS = 300;

/**
 * Lets a scene use recorded or uploaded audio instead of a voice: the presenter lip-syncs to the
 * clip. Recordings and uploads are converted to WAV in the browser and saved as clips, so they can
 * be reused in other scenes and videos.
 */
export function SceneAudio({
  clips,
  clipId,
  disabled,
  onUse,
  onClear,
  onSaved,
}: {
  clips: AudioClip[];
  clipId?: string;
  disabled?: boolean;
  onUse: (clip: AudioClip) => void;
  onClear: () => void;
  onSaved: (clip: AudioClip) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Until the clip list arrives (or if it fails), a scene that names a clip still shows that it speaks one.
  const clip: AudioClip | undefined = clipId ? (clips.find((c) => c.id === clipId) ?? { id: clipId, name: "Saved clip", mimeType: "audio/wav", bytes: 0, durationSec: 0, createdAt: "" }) : undefined;

  useEffect(() => () => stopRecording(), []);

  async function save(blob: Blob, name: string) {
    setBusy(true);
    setErr(null);
    try {
      const { dataUrl } = await toWavDataUrl(blob);
      const { clip: saved } = await api<{ clip: AudioClip }>("/api/clips", { method: "POST", body: JSON.stringify({ name, audio: dataUrl }) });
      onSaved(saved);
      onUse(saved);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the audio");
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Chrome and Firefox record WebM, Safari MP4; the browser decodes either before conversion.
      const rec = MediaRecorder.isTypeSupported?.("audio/webm") ? new MediaRecorder(stream, { mimeType: "audio/webm" }) : new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
        if (blob.size > 0) void save(blob, `Recording ${new Date().toLocaleString()}`);
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
      setSeconds(0);
      timer.current = setInterval(() => {
        setSeconds((n) => {
          if (n + 1 >= MAX_RECORD_SECONDS) stopRecording();
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

  if (clip) {
    return (
      <div className="mb-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-slate-700" data-testid="scene-audio">
        <div className="flex flex-wrap items-center gap-2">
          <Mic className="h-4 w-4 text-brand-600" aria-hidden />
          <span className="font-medium">Speaks recorded audio:</span>
          <span data-testid="scene-audio-name">{clip.name}</span>
          {clip.durationSec > 0 && <span className="text-slate-500">· {formatSeconds(Math.max(1, Math.round(clip.durationSec)))}</span>}
          <button type="button" onClick={onClear} disabled={disabled} className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-brand-700 hover:bg-white disabled:opacity-50">
            <X className="h-3.5 w-3.5" /> Use a voice instead
          </button>
        </div>
        <audio controls preload="none" src={`/api/clips/${clip.id}`} className="mt-2 h-8 w-full" aria-label={`Play ${clip.name}`} />
        <p className="mt-1 text-slate-500">The presenter lip-syncs to this clip; the voice, speed, and pitch settings do not apply to it. Type what it says below for captions and search.</p>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="scene-audio">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-700">Or use your own audio</span>
        {recording ? (
          <Button variant="danger" className="px-2.5 py-1 text-xs" onClick={stopRecording}>
            <Square className="h-3.5 w-3.5" /> Stop · {formatSeconds(seconds)}
          </Button>
        ) : (
          <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={startRecording} disabled={disabled || busy}>
            <Mic className="h-3.5 w-3.5" /> Record
          </Button>
        )}
        <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => fileRef.current?.click()} disabled={disabled || busy || recording} loading={busy}>
          <Upload className="h-3.5 w-3.5" /> Upload audio
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          aria-label="Upload scene audio"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void save(file, file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Uploaded audio");
          }}
        />
        {clips.length > 0 && (
          <select
            aria-label="Use a saved clip"
            className={`${inputClass} w-auto py-1 text-xs`}
            value=""
            disabled={disabled || busy || recording}
            onChange={(e) => {
              const picked = clips.find((c) => c.id === e.target.value);
              if (picked) onUse(picked);
            }}
          >
            <option value="">Saved clips…</option>
            {clips.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({formatSeconds(Math.max(1, Math.round(c.durationSec)))})
              </option>
            ))}
          </select>
        )}
      </div>
      <ErrorBanner message={err} />
    </div>
  );
}
