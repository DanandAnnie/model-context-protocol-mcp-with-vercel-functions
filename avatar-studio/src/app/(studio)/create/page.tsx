"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Captions, Clapperboard, Image as ImageIcon, Layers, Mic2, Palette, Play, Plus, Sparkles, Square, Trash2, Users, Wand2, X } from "lucide-react";
import { AvatarGrid } from "@/components/AvatarPicker";
import { VoiceRow } from "@/components/VoicePicker";
import { Button, Card, ErrorBanner, Field, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useVoicePreview } from "@/hooks/useVoicePreview";
import { api, estimateSeconds, formatSeconds, isDarkHex, wordCount } from "@/lib/client";
import { portraitSvg } from "@/lib/stock";
import { findTemplate } from "@/lib/templates";
import { MAX_SCENES, type AspectRatio, type Avatar, type Background, type BrandKit, type Scene, type Video, type Voice } from "@/lib/types";

const BG_PRESETS = ["#f1f5f9", "#ffffff", "#0f172a", "#1e3a8a", "#4f46e5", "#065f46", "#7c2d12", "#be123c"];
const DEFAULT_BG: Background = { type: "color", value: "#f1f5f9" };
const DRAFT_KEY = "avatar-studio:draft";

interface Draft {
  title: string;
  scenes: Scene[];
  aspect: AspectRatio;
  captions: boolean;
  speed: number;
  avatarId?: string;
  voiceId?: string;
  savedAt: string;
}

function readDraft(): Draft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return Array.isArray(d.scenes) && d.scenes.length ? d : null;
  } catch {
    return null;
  }
}

function writeDraft(d: Draft | null) {
  try {
    if (d) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage can be unavailable (private mode); drafts are a convenience only.
  }
}
const newScene = (script = "", background: Background = DEFAULT_BG): Scene => ({ script, background });
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
  const { data: brandData } = useApi<{ brand: BrandKit | null }>("/api/brand");
  const { play, playingId, busyId } = useVoicePreview();

  const [title, setTitle] = useState("Untitled video");
  const [scenes, setScenes] = useState<Scene[]>([newScene()]);
  const [activeIdx, setActiveIdx] = useState(0);
  const active = scenes[Math.min(activeIdx, scenes.length - 1)];
  const script = scenes.map((s) => s.script).join("\n\n");
  const background = active.background;
  const setScript = (value: string) => updateScene(activeIdx, { script: value });
  const setBackground = (value: Background) => updateScene(activeIdx, { background: value });
  function updateScene(idx: number, patch: Partial<Scene>) {
    setScenes((prev) => prev.map((sc, i) => (i === idx ? { ...sc, ...patch } : sc)));
  }
  function addScene() {
    if (scenes.length >= MAX_SCENES) return;
    setScenes((prev) => [...prev, newScene("", prev[prev.length - 1].background)]);
    setActiveIdx(scenes.length);
  }
  function removeScene(idx: number) {
    if (scenes.length <= 1) return;
    setScenes((prev) => prev.filter((_, i) => i !== idx));
    setActiveIdx(Math.max(0, idx - 1));
  }
  const [avatar, setAvatar] = useState<Avatar | null>(null);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [aspect, setAspect] = useState<AspectRatio>("16:9");
  const [captions, setCaptions] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState<Tab>("avatar");
  const [writerOpen, setWriterOpen] = useState(params.get("writer") === "1");
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistTone, setAssistTone] = useState<(typeof TONES)[number]>("professional");
  const [assistLanguage, setAssistLanguage] = useState("Spanish");

  async function revise(action: "shorten" | "expand" | "tone" | "translate" | "polish") {
    if (!active.script.trim()) return;
    setAssistBusy(true);
    setErr(null);
    try {
      const { script: out } = await api<{ script: string }>("/api/script", {
        method: "POST",
        body: JSON.stringify({ action, script: active.script, tone: action === "tone" ? assistTone : undefined, language: action === "translate" ? assistLanguage : undefined }),
      });
      setScript(out);
      setAssistOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not revise the script");
    } finally {
      setAssistBusy(false);
    }
  }
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [voiceQuery, setVoiceQuery] = useState("");

  const [prefill, setPrefill] = useState<{ avatarId?: string; voiceId?: string } | null>(null);
  const [draftRestored, setDraftRestored] = useState<string | null>(null);
  const hydrated = useRef(false);
  const templateId = params.get("template");
  const fromId = params.get("from");

  // Restore an unsent draft on a plain visit (not when a template or copy is requested).
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    if (templateId || fromId) return;
    const d = readDraft();
    if (!d) return;
    setTitle(d.title);
    setScenes(d.scenes.map((sc) => newScene(sc.script, sc.background)));
    setActiveIdx(0);
    setAspect(d.aspect);
    setCaptions(d.captions);
    setSpeed(d.speed);
    setPrefill({ avatarId: d.avatarId, voiceId: d.voiceId });
    setDraftRestored(d.savedAt);
  }, [templateId, fromId]);

  // Autosave the editor state (debounced) so a refresh never loses work.
  useEffect(() => {
    if (!hydrated.current) return;
    const empty = scenes.every((sc) => !sc.script.trim()) && title === "Untitled video";
    const t = setTimeout(() => {
      writeDraft(empty ? null : { title, scenes, aspect, captions, speed, avatarId: avatar?.id, voiceId: voice?.id, savedAt: new Date().toISOString() });
    }, 400);
    return () => clearTimeout(t);
  }, [title, scenes, aspect, captions, speed, avatar, voice]);

  function discardDraft() {
    writeDraft(null);
    setTitle("Untitled video");
    setScenes([newScene()]);
    setActiveIdx(0);
    setAspect("16:9");
    setCaptions(false);
    setSpeed(1);
    setDraftRestored(null);
  }

  // Brand kit defaults for a fresh editor: avatar, voice, captions, and (without a template) aspect and background.
  // Restored drafts and copies keep what they had.
  const brandApplied = useRef(false);
  useEffect(() => {
    if (brandApplied.current || !brandData) return;
    brandApplied.current = true;
    const b = brandData.brand;
    if (!b || fromId || draftRestored) return;
    if (b.captionsByDefault != null) setCaptions(b.captionsByDefault);
    if (b.defaultAvatarId || b.defaultVoiceId) setPrefill({ avatarId: b.defaultAvatarId, voiceId: b.defaultVoiceId });
    if (templateId) return;
    if (b.defaultAspect) setAspect(b.defaultAspect);
    setScenes((prev) => prev.map((sc) => (sc.script.trim() ? sc : { ...sc, background: { type: "color", value: b.primaryColor } })));
  }, [brandData, fromId, templateId, draftRestored]);

  // Pre-fill from a template (?template=) or an existing video (?from=).
  useEffect(() => {
    const t = findTemplate(templateId);
    if (t) {
      setTitle(t.title);
      setScenes([newScene(t.script)]);
      setActiveIdx(0);
      setAspect(t.aspect);
    }
  }, [templateId]);
  useEffect(() => {
    if (!fromId) return;
    api<{ video: Video }>(`/api/videos/${fromId}`)
      .then(({ video }) => {
        setTitle(`${video.title} (copy)`);
        setScenes(video.scenes?.length ? video.scenes.map((sc) => newScene(sc.script, sc.background)) : [newScene(video.script, video.background)]);
        setActiveIdx(0);
        setAspect(video.aspect);
        setCaptions(video.captions);
        setSpeed(video.speed);
        setPrefill({ avatarId: video.avatarId, voiceId: video.voiceId });
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not load the original video"));
  }, [fromId]);

  // Default selections once data arrives.
  useEffect(() => {
    if (!avatar && avatarData?.avatars.length) setAvatar(avatarData.avatars[0]);
  }, [avatarData, avatar]);
  useEffect(() => {
    if (!voice && voiceData?.voices.length) setVoice(voiceData.voices[0]);
  }, [voiceData, voice]);
  // Apply a copied video's avatar/voice once both lists are loaded, then clear the prefill.
  useEffect(() => {
    if (!prefill || !avatarData || !voiceData) return;
    const a = avatarData.avatars.find((x) => x.id === prefill.avatarId);
    const v = voiceData.voices.find((x) => x.id === prefill.voiceId);
    if (a) setAvatar(a);
    if (v) setVoice(v);
    setPrefill(null);
  }, [prefill, avatarData, voiceData]);

  const voices = useMemo(() => {
    const all = voiceData?.voices ?? [];
    const q = voiceQuery.trim().toLowerCase();
    return q ? all.filter((v) => [v.name, v.language, v.gender, ...(v.tags ?? [])].filter(Boolean).join(" ").toLowerCase().includes(q)) : all;
  }, [voiceData, voiceQuery]);

  const words = wordCount(script);
  const seconds = estimateSeconds(script, speed);
  const allScenesFilled = scenes.every((sc) => sc.script.trim().length > 0);
  const canGenerate = !!avatar && !!voice && allScenesFilled && title.trim().length > 0 && !submitting;

  async function generate() {
    if (!avatar || !voice) return;
    setSubmitting(true);
    setErr(null);
    try {
      const { video } = await api<{ video: Video }>("/api/videos", {
        method: "POST",
        body: JSON.stringify({ title, scenes, avatarId: avatar.id, voiceId: voice.id, aspect, captions, speed }),
      });
      writeDraft(null);
      router.push(`/videos/${video.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the render");
      setSubmitting(false);
    }
  }

  // Ctrl/Cmd+Enter generates from anywhere in the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canGenerate) {
        e.preventDefault();
        generate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canGenerate, title, scenes, avatar, voice, aspect, captions, speed]);

  const stageAspect = aspect === "9:16" ? "aspect-[9/16]" : aspect === "1:1" ? "aspect-square" : "aspect-video";
  const bgIsDark = background.type === "color" && isDarkHex(background.value);

  return (
    <>
      <SectionTitle
        title="Create video"
        subtitle="Write the script, choose who says it and how it looks, then generate."
        action={
          <Button onClick={generate} disabled={!canGenerate} loading={submitting} title="Ctrl/Cmd + Enter">
            <Clapperboard className="h-4 w-4" /> Generate video
          </Button>
        }
      />
      <ErrorBanner message={err ?? avatarsError ?? voicesError} />
      {draftRestored && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <span>Restored your unsent draft from {new Date(draftRestored).toLocaleString()}.</span>
          <button type="button" onClick={discardDraft} className="font-medium underline hover:no-underline">
            Discard draft
          </button>
        </div>
      )}

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
              {captions && active.script.trim() && (
                <div className={`absolute bottom-4 left-1/2 max-w-[85%] -translate-x-1/2 rounded-md px-3 py-1.5 text-center text-sm font-medium ${bgIsDark ? "bg-white/90 text-slate-900" : "bg-black/80 text-white"}`}>
                  {active.script.trim().split(/(?<=[.!?])\s+/)[0].slice(0, 90)}
                </div>
              )}
              <span className={`absolute left-3 top-3 rounded px-2 py-0.5 text-[11px] font-medium ${bgIsDark ? "bg-white/15 text-white" : "bg-black/10 text-slate-800"}`}>
                {aspect} preview{scenes.length > 1 ? ` · scene ${activeIdx + 1}` : ""}
              </span>
            </div>
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="mr-1 inline-flex items-center gap-1 text-xs font-medium text-slate-500"><Layers className="h-3.5 w-3.5" /> Scenes</span>
              {scenes.map((sc, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveIdx(i)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                    i === activeIdx ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <span className="h-2.5 w-2.5 rounded-full border border-black/10" style={sc.background.type === "color" ? { background: sc.background.value } : { background: "linear-gradient(135deg,#94a3b8,#cbd5e1)" }} />
                  {i + 1}
                  {!sc.script.trim() && <span className="text-amber-500" title="Empty scene">•</span>}
                </button>
              ))}
              <button
                type="button"
                onClick={addScene}
                disabled={scenes.length >= MAX_SCENES}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" /> Add scene
              </button>
              {scenes.length > 1 && (
                <button type="button" onClick={() => removeScene(activeIdx)} aria-label="Remove scene" className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-slate-500 hover:bg-rose-50 hover:text-rose-600">
                  <Trash2 className="h-3.5 w-3.5" /> Remove scene {activeIdx + 1}
                </button>
              )}
            </div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">{scenes.length > 1 ? `Scene ${activeIdx + 1} script` : "Script"}</h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">
                  {words} words · ~{formatSeconds(seconds)}{scenes.length > 1 ? " total" : ""}
                </span>
                <Button variant="secondary" className="px-3 py-1.5" onClick={() => setWriterOpen((v) => !v)}>
                  <Wand2 className="h-4 w-4" /> Write with AI
                </Button>
                <div className="relative">
                  <Button variant="secondary" className="px-3 py-1.5" disabled={!active.script.trim()} loading={assistBusy} onClick={() => setAssistOpen((v) => !v)}>
                    <Sparkles className="h-4 w-4" /> Improve
                  </Button>
                  {assistOpen && (
                    <div className="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
                      {(
                        [
                          ["polish", "Polish for speech"],
                          ["shorten", "Shorten"],
                          ["expand", "Expand"],
                        ] as const
                      ).map(([action, label]) => (
                        <button key={action} type="button" onClick={() => revise(action)} className="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100">
                          {label}
                        </button>
                      ))}
                      <div className="mt-1 flex items-center gap-1 border-t border-slate-100 px-1 pt-2">
                        <select className={`${inputClass} py-1.5 text-xs`} value={assistTone} onChange={(e) => setAssistTone(e.target.value as typeof assistTone)}>
                          {TONES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                        </select>
                        <button type="button" onClick={() => revise("tone")} className="shrink-0 rounded-md px-2 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50">Change tone</button>
                      </div>
                      <div className="mt-1 flex items-center gap-1 px-1">
                        <input className={`${inputClass} py-1.5 text-xs`} value={assistLanguage} onChange={(e) => setAssistLanguage(e.target.value)} placeholder="Language" />
                        <button type="button" onClick={() => revise("translate")} className="shrink-0 rounded-md px-2 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50">Translate</button>
                      </div>
                    </div>
                  )}
                </div>
                {voice && (
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5"
                    disabled={!active.script.trim()}
                    loading={busyId === voice.id}
                    onClick={() => play(voice, active.script.slice(0, 400), speed).catch((e) => setErr(e.message))}
                  >
                    {playingId === voice.id ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {playingId === voice.id ? "Stop" : "Listen"}
                  </Button>
                )}
              </div>
            </div>
            {writerOpen && <ScriptWriter onClose={() => setWriterOpen(false)} onScript={(s) => { setScript(s); setWriterOpen(false); }} />}
            <textarea
              key={activeIdx}
              className={`${inputClass} min-h-[220px] resize-y leading-relaxed`}
              value={active.script}
              onChange={(e) => setScript(e.target.value)}
              placeholder={scenes.length > 1 ? `What the avatar says in scene ${activeIdx + 1}.` : "Type what your avatar should say, or click “Write with AI”."}
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
                {scenes.length > 1 && <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Editing the background for scene {activeIdx + 1}. Each scene keeps its own background.</p>}
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
                      onChange={(e) => setBackground(e.target.value ? { type: "image", value: e.target.value } : DEFAULT_BG)}
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
            {avatar ? `${avatar.name}` : "No avatar"} · {voice ? voice.name : "No voice"} · {aspect} · {scenes.length} {scenes.length === 1 ? "scene" : "scenes"} · {captions ? "captions on" : "no captions"}
          </div>
        </Card>
      </div>
    </>
  );
}

function ScriptWriter({ onScript, onClose }: { onScript: (s: string) => void; onClose: () => void }) {
  const [topic, setTopic] = useState("");
  const [url, setUrl] = useState("");
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
        body: JSON.stringify({ topic, url: url.trim() || undefined, tone, lengthSec, language, audience: audience || undefined }),
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
        <input className={inputClass} type="url" aria-label="Page URL" placeholder="Or paste a public web page to write from (a listing, a blog post, a product page)" value={url} onChange={(e) => setUrl(e.target.value)} />
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
          <Button onClick={run} loading={busy} disabled={topic.trim().length < 3 && !url.trim()}>Write script</Button>
        </div>
      </div>
    </div>
  );
}

