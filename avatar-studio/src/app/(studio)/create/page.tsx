"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Captions, Clapperboard, Image as ImageIcon, Mic2, Palette, Play, Square, Users, Wand2, X } from "lucide-react";
import { AvatarGrid } from "@/components/AvatarPicker";
import { VoiceRow } from "@/components/VoicePicker";
import { Button, Card, ErrorBanner, Field, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useVoicePreview } from "@/hooks/useVoicePreview";
import { api, estimateSeconds, formatSeconds, wordCount } from "@/lib/client";
import { portraitSvg } from "@/lib/stock";
import type { AspectRatio, Avatar, Background, Video, Voice } from "@/lib/types";

const BG_PRESETS = ["#f1f5f9", "#ffffff", "#0f172a", "#1e3a8a", "#4f46e5", "#065f46", "#7c2d12", "#be123c"];
const TONES = ["friendly", "professional", "formal", "energetic", "calm"] as const;
type Tab = "avatar" | "voice" | "background" | "settings";

export default function CreatePage() {
  return (
    <Suspense>
      <CreateInner />
    </Suspense>
  );
}

function CreateInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: avatarData, loading: avatarsLoading, error: avatarsError } = useApi<{ avatars: Avatar[] }>("/api/avatars");
  const { data: voiceData, loading: voicesLoading, error: voicesError } = useApi<{ voices: Voice[] }>("/api/voices");
  const { play, playingId, busyId } = useVoicePreview();

  const [title, setTitle] = useState("Untitled video");
  const [script, setScript] = useState("");
  const [avatar, setAvatar] = useState<Avatar | null>(null);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [aspect, setAspect] = useState<AspectRatio>("16:9");
  const [background, setBackground] = useState<Background>({ type: "color", value: "#f1f5f9" });
  const [captions, setCaptions] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState<Tab>("avatar");
  const [writerOpen, setWriterOpen] = useState(params.get("writer") === "1");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [voiceQuery, setVoiceQuery] = useState("");

  // Default selections once data arrives.
  useEffect(() => {
    if (!avatar && avatarData?.avatars.length) setAvatar(avatarData.avatars[0]);
  }, [avatarData, avatar]);
  useEffect(() => {
    if (!voice && voiceData?.voices.length) setVoice(voiceData.voices[0]);
  }, [voiceData, voice]);

  const voices = useMemo(() => {
    const all = voiceData?.voices ?? [];
    const q = voiceQuery.trim().toLowerCase();
    return q ? all.filter((v) => [v.name, v.language, v.gender, ...(v.tags ?? [])].filter(Boolean).join(" ").toLowerCase().includes(q)) : all;
  }, [voiceData, voiceQuery]);

  const words = wordCount(script);
  const seconds = estimateSeconds(script, speed);
  const canGenerate = !!avatar && !!voice && script.trim().length > 0 && title.trim().length > 0 && !submitting;

  async function generate() {
    if (!avatar || !voice) return;
    setSubmitting(true);
    setErr(null);
    try {
      const { video } = await api<{ video: Video }>("/api/videos", {
        method: "POST",
        body: JSON.stringify({ title, script, avatarId: avatar.id, voiceId: voice.id, aspect, background, captions, speed }),
      });
      router.push(`/videos/${video.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the render");
      setSubmitting(false);
    }
  }

  const stageAspect = aspect === "9:16" ? "aspect-[9/16]" : aspect === "1:1" ? "aspect-square" : "aspect-video";
  const bgIsDark = background.type === "color" && isDark(background.value);

  return (
    <>
      <SectionTitle
        title="Create video"
        subtitle="Write the script, choose who says it and how it looks, then generate."
        action={
          <Button onClick={generate} disabled={!canGenerate} loading={submitting}>
            <Clapperboard className="h-4 w-4" /> Generate video
          </Button>
        }
      />
      <ErrorBanner message={err ?? avatarsError ?? voicesError} />

      <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
        {/* Left column: stage + script */}
        <div className="space-y-5">
          <input className={`${inputClass} text-base font-medium`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Video title" />

          <Card className="overflow-hidden">
            <div className={`relative mx-auto w-full ${stageAspect} ${aspect === "9:16" ? "max-h-[520px]" : ""} flex items-end justify-center overflow-hidden`} style={background.type === "color" ? { background: background.value } : { backgroundImage: `url(${background.value})`, backgroundSize: "cover", backgroundPosition: "center" }}>
              {avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatar.imageUrl}
                  alt={avatar.name}
                  className={`${aspect === "16:9" ? "h-[92%]" : "h-[80%]"} max-w-[80%] object-contain object-bottom drop-shadow-xl`}
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (!img.dataset.fallback) {
                      img.dataset.fallback = "1";
                      img.src = portraitSvg(avatar.name, avatar.name.length);
                    }
                  }}
                />
              ) : (
                <Skeleton className="h-3/4 w-1/3" />
              )}
              {captions && script.trim() && (
                <div className={`absolute bottom-4 left-1/2 max-w-[85%] -translate-x-1/2 rounded-md px-3 py-1.5 text-center text-sm font-medium ${bgIsDark ? "bg-white/90 text-slate-900" : "bg-black/80 text-white"}`}>
                  {script.trim().split(/(?<=[.!?])\s+/)[0].slice(0, 90)}
                </div>
              )}
              <span className={`absolute left-3 top-3 rounded px-2 py-0.5 text-[11px] font-medium ${bgIsDark ? "bg-white/15 text-white" : "bg-black/10 text-slate-800"}`}>{aspect} preview</span>
            </div>
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Script</h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">
                  {words} words · ~{formatSeconds(seconds)}
                </span>
                <Button variant="secondary" className="px-3 py-1.5" onClick={() => setWriterOpen((v) => !v)}>
                  <Wand2 className="h-4 w-4" /> Write with AI
                </Button>
                {voice && (
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5"
                    disabled={!script.trim()}
                    loading={busyId === voice.id}
                    onClick={() => play(voice, script.slice(0, 400), speed).catch((e) => setErr(e.message))}
                  >
                    {playingId === voice.id ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {playingId === voice.id ? "Stop" : "Listen"}
                  </Button>
                )}
              </div>
            </div>
            {writerOpen && <ScriptWriter onClose={() => setWriterOpen(false)} onScript={(s) => { setScript(s); setWriterOpen(false); }} />}
            <textarea
              className={`${inputClass} min-h-[220px] resize-y leading-relaxed`}
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="Type what your avatar should say, or click “Write with AI”."
              maxLength={5000}
            />
          </Card>
        </div>

        {/* Right column: configuration tabs */}
        <Card className="flex max-h-[calc(100vh-11rem)] flex-col">
          <div className="flex border-b border-slate-200">
            {(
              [
                ["avatar", "Avatar", Users],
                ["voice", "Voice", Mic2],
                ["background", "Background", Palette],
                ["settings", "Settings", Captions],
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex flex-1 items-center justify-center gap-2 px-3 py-3 text-sm font-medium ${tab === key ? "border-b-2 border-brand-600 text-brand-700" : "text-slate-500 hover:text-slate-900"}`}
              >
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {tab === "avatar" && (
              avatarsLoading ? (
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                  {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="aspect-[4/5]" />)}
                </div>
              ) : (
                <AvatarGrid avatars={avatarData?.avatars ?? []} selectedId={avatar?.id} onSelect={setAvatar} compact />
              )
            )}

            {tab === "voice" && (
              <div className="space-y-2">
                <input className={inputClass} placeholder="Search voices" value={voiceQuery} onChange={(e) => setVoiceQuery(e.target.value)} />
                {voicesLoading
                  ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)
                  : voices.map((v) => (
                      <VoiceRow
                        key={v.id}
                        voice={v}
                        selected={voice?.id === v.id}
                        onSelect={() => setVoice(v)}
                        playing={playingId === v.id}
                        busy={busyId === v.id}
                        onPreview={() => play(v, script.trim().slice(0, 200) || "Hi, this is a preview of my voice.", speed).catch((e) => setErr(e.message))}
                      />
                    ))}
              </div>
            )}

            {tab === "background" && (
              <div className="space-y-5">
                <div>
                  <div className="mb-2 text-sm font-medium text-slate-700">Solid color</div>
                  <div className="flex flex-wrap gap-2">
                    {BG_PRESETS.map((c) => (
                      <button
                        key={c}
                        onClick={() => setBackground({ type: "color", value: c })}
                        aria-label={`Background ${c}`}
                        className={`h-9 w-9 rounded-lg border ${background.type === "color" && background.value === c ? "ring-2 ring-brand-500 border-brand-500" : "border-slate-200"}`}
                        style={{ background: c }}
                      />
                    ))}
                    <input
                      type="color"
                      aria-label="Custom color"
                      value={background.type === "color" ? background.value : "#ffffff"}
                      onChange={(e) => setBackground({ type: "color", value: e.target.value })}
                      className="h-9 w-9 cursor-pointer rounded-lg border border-slate-200 bg-white p-0.5"
                    />
                  </div>
                </div>
                <Field label="Image URL" hint="A public image URL. Shown behind the avatar.">
                  <div className="flex gap-2">
                    <input
                      className={inputClass}
                      placeholder="https://…/background.jpg"
                      value={background.type === "image" ? background.value : ""}
                      onChange={(e) => setBackground(e.target.value ? { type: "image", value: e.target.value } : { type: "color", value: "#f1f5f9" })}
                    />
                    <span className="flex items-center text-slate-400"><ImageIcon className="h-5 w-5" /></span>
                  </div>
                </Field>
              </div>
            )}

            {tab === "settings" && (
              <div className="space-y-5">
                <div>
                  <div className="mb-2 text-sm font-medium text-slate-700">Aspect ratio</div>
                  <div className="grid grid-cols-3 gap-2">
                    {(["16:9", "9:16", "1:1"] as AspectRatio[]).map((a) => (
                      <button
                        key={a}
                        onClick={() => setAspect(a)}
                        className={`rounded-lg border px-3 py-3 text-sm font-medium ${aspect === a ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}
                      >
                        {a}
                        <div className="text-[11px] font-normal text-slate-500">{a === "16:9" ? "Landscape" : a === "9:16" ? "Portrait" : "Square"}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <Field label={`Speaking speed · ${speed.toFixed(2)}x`}>
                  <input type="range" min={0.5} max={1.5} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full accent-brand-600" />
                </Field>
                <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-3">
                  <span>
                    <span className="block text-sm font-medium text-slate-800">Captions</span>
                    <span className="block text-xs text-slate-500">Burn subtitles into the video.</span>
                  </span>
                  <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} className="h-5 w-5 accent-brand-600" />
                </label>
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 p-4 text-xs text-slate-500">
            {avatar ? `${avatar.name}` : "No avatar"} · {voice ? voice.name : "No voice"} · {aspect} · {captions ? "captions on" : "no captions"}
          </div>
        </Card>
      </div>
    </>
  );
}

function ScriptWriter({ onScript, onClose }: { onScript: (s: string) => void; onClose: () => void }) {
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState<(typeof TONES)[number]>("friendly");
  const [lengthSec, setLength] = useState(45);
  const [language, setLanguage] = useState("English");
  const [audience, setAudience] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const { script } = await api<{ script: string }>("/api/script", {
        method: "POST",
        body: JSON.stringify({ topic, tone, lengthSec, language, audience: audience || undefined }),
      });
      onScript(script);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not write the script");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3 rounded-lg border border-brand-200 bg-brand-50/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-brand-800"><Wand2 className="h-4 w-4" /> AI script writer</div>
        <button onClick={onClose} aria-label="Close" className="text-slate-500 hover:text-slate-900"><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-3">
        <input className={inputClass} placeholder="What is the video about? e.g. Welcome new tenants to our property portal" value={topic} onChange={(e) => setTopic(e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-3">
          <select className={inputClass} value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}>
            {TONES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
          </select>
          <select className={inputClass} value={lengthSec} onChange={(e) => setLength(Number(e.target.value))}>
            {[15, 30, 45, 60, 90, 120].map((s) => <option key={s} value={s}>{s} seconds</option>)}
          </select>
          <input className={inputClass} value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="Language" />
        </div>
        <input className={inputClass} placeholder="Audience (optional), e.g. first-time landlords" value={audience} onChange={(e) => setAudience(e.target.value)} />
        <ErrorBanner message={err} />
        <div className="flex justify-end">
          <Button onClick={run} loading={busy} disabled={topic.trim().length < 3}>Write script</Button>
        </div>
      </div>
    </div>
  );
}

function isDark(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}
