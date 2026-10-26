"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Pause, Play, Wand2 } from "lucide-react";
import { Button, Card, ErrorBanner, Field, inputClass } from "@/components/ui";
import { api } from "@/lib/client";
import type { Voice } from "@/lib/types";

interface Preview {
  previewId: string;
  audioUrl?: string;
  durationSec?: number;
}

const EXAMPLES = [
  "A warm, friendly woman in her thirties with a light Irish accent, speaking at an easy, reassuring pace.",
  "A confident, deep-voiced American man in his fifties, calm and authoritative, like a documentary narrator.",
  "An upbeat young British presenter, bright and energetic, quick but always clear.",
];

/** In demo mode the browser reads each preview, at a different pitch so the three can be told apart. */
const DEMO_PITCH = [0.85, 1, 1.2];

/**
 * Designs a voice from a written description, as HeyGen's voice designer does: the provider offers a few previews of a
 * sample, the one chosen is kept as a voice of the account, usable in every video like a cloned one.
 */
export function VoiceDesigner({ available, onSaved }: { available: boolean; onSaved: (v: Voice) => void }) {
  const id = useId();
  const [description, setDescription] = useState("");
  const [text, setText] = useState("");
  const [previews, setPreviews] = useState<Preview[] | null>(null);
  const [sample, setSample] = useState("");
  const [designedFor, setDesignedFor] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"design" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const firstPreview = useRef<HTMLInputElement>(null);

  function stop() {
    audio.current?.pause();
    audio.current = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    setPlaying(null);
  }
  useEffect(() => stop, []);

  async function design() {
    stop();
    setBusy("design");
    setErr(null);
    setNote(null);
    try {
      const out = await api<{ text: string; previews: Preview[] }>("/api/voices/design", { method: "POST", body: JSON.stringify({ description, text: text.trim() || undefined }) });
      setPreviews(out.previews);
      setSample(out.text);
      // The previews belong to this description: saving one keeps the description it was made from.
      setDesignedFor(description.trim());
      setChosen(null);
      requestAnimationFrame(() => firstPreview.current?.focus());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not design the voice");
    } finally {
      setBusy(null);
    }
  }

  function play(p: Preview, i: number) {
    if (playing === p.previewId) return stop();
    stop();
    setPlaying(p.previewId);
    if (p.audioUrl) {
      const a = new Audio(p.audioUrl);
      a.onended = () => setPlaying(null);
      audio.current = a;
      a.play().catch(() => {
        setPlaying(null);
        setErr("The preview could not be played");
      });
      return;
    }
    if (!("speechSynthesis" in window)) {
      setPlaying(null);
      setErr("This browser cannot play speech previews.");
      return;
    }
    const utter = new SpeechSynthesisUtterance(sample);
    utter.pitch = DEMO_PITCH[i % DEMO_PITCH.length];
    utter.onend = () => setPlaying(null);
    utter.onerror = () => setPlaying(null);
    window.speechSynthesis.speak(utter);
  }

  async function save() {
    if (!chosen) return;
    stop();
    setBusy("save");
    setErr(null);
    try {
      const { voice } = await api<{ voice: Voice }>("/api/voices/design/save", { method: "POST", body: JSON.stringify({ name, description: designedFor, previewId: chosen }) });
      setNote(`Saved "${voice.name}". It is at the top of your voices and in every voice picker.`);
      setPreviews(null);
      setChosen(null);
      setName("");
      onSaved(voice);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the voice");
    } finally {
      setBusy(null);
    }
  }

  const short = description.trim().length < 20;
  const textShort = text.trim().length > 0 && text.trim().length < 100;
  return (
    <Card className="p-5" data-testid="voice-designer">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Wand2 className="h-4 w-4 text-slate-400" /> Design a voice
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        Describe the voice you want (age, accent, tone, pace) and choose from the previews. The voice you keep is private to your account and usable in every video.
        {!available && " Voice design needs TTS_PROVIDER=elevenlabs; in demo mode the voice is saved and previews use the browser voice."}
      </p>
      <ErrorBanner message={err} />
      <div className="mt-3 space-y-3">
        <Field label="Describe the voice">
          <textarea
            aria-describedby={`${id}-hint`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder={EXAMPLES[0]}
            className={`${inputClass} resize-y`}
          />
        </Field>
        <p id={`${id}-hint`} className="-mt-2 text-xs text-slate-500">
          At least 20 characters. The more you say, the closer the previews come.
        </p>
        <div className="flex flex-wrap gap-2" aria-label="Example descriptions" role="group">
          {EXAMPLES.map((ex, i) => (
            <button key={i} type="button" onClick={() => setDescription(ex)} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600 hover:border-brand-400 hover:text-brand-700">
              {["Warm Irish narrator", "Documentary voice", "Upbeat presenter"][i]}
            </button>
          ))}
        </div>
        <Field label="Sample text (optional)">
          <textarea
            aria-describedby={`${id}-text`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
            rows={2}
            placeholder="Leave empty for a sample written to suit the description"
            className={`${inputClass} resize-y`}
          />
        </Field>
        <p id={`${id}-text`} className={`-mt-2 text-xs ${textShort ? "text-amber-700" : "text-slate-500"}`}>
          {textShort ? `The previews need at least 100 characters to read (${text.trim().length} so far), or leave it empty.` : "100 to 1000 characters, read by each preview."}
        </p>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={design} loading={busy === "design"} disabled={short || textShort || busy !== null}>
            <Wand2 className="h-4 w-4" /> {previews ? "Design again" : "Design previews"}
          </Button>
        </div>
      </div>
      {previews && (
        <fieldset className="mt-4 space-y-2" data-testid="voice-previews">
          <legend className="text-xs font-medium text-slate-700">Choose a preview</legend>
          {previews.map((p, i) => (
            <div key={p.previewId} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${chosen === p.previewId ? "border-brand-500 bg-brand-50/60" : "border-slate-200"}`}>
              <label className="flex flex-1 items-center gap-2 text-sm text-slate-700">
                <input ref={i === 0 ? firstPreview : undefined} type="radio" name={`${id}-preview`} className="accent-brand-600" checked={chosen === p.previewId} onChange={() => setChosen(p.previewId)} />
                Preview {i + 1}
                {p.durationSec ? <span className="text-xs text-slate-500">{Math.round(p.durationSec)}s</span> : null}
              </label>
              <button
                type="button"
                onClick={() => play(p, i)}
                aria-label={playing === p.previewId ? `Stop preview ${i + 1}` : `Play preview ${i + 1}`}
                className="rounded-full p-1.5 text-slate-600 hover:bg-slate-100"
              >
                {playing === p.previewId ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
            </div>
          ))}
          {sample && <p className="text-xs text-slate-500">Each preview reads: “{sample}”</p>}
          <div className="grid gap-3 pt-1 md:grid-cols-[1fr_auto]">
            <Field label="Name for the voice">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Narrator (designed)" className={inputClass} />
            </Field>
            <div className="flex items-end">
              <Button onClick={save} loading={busy === "save"} disabled={!chosen || !name.trim() || busy !== null}>
                Save voice
              </Button>
            </div>
          </div>
        </fieldset>
      )}
      <p role="status" className={note ? "mt-3 text-xs text-emerald-700" : "sr-only"}>
        {note ?? ""}
      </p>
    </Card>
  );
}
