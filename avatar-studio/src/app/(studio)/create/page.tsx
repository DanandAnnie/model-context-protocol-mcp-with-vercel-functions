"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Captions, ChevronLeft, ChevronRight, Clapperboard, Copy, Image as ImageIcon, Layers, Mic2, Palette, Pause, Play, Plus, Sparkles, Square, Trash2, Users, Wand2, X } from "lucide-react";
import { AvatarGrid } from "@/components/AvatarPicker";
import { VoiceRow } from "@/components/VoicePicker";
import { Button, Card, ErrorBanner, Field, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { SceneAudio } from "@/components/SceneAudio";
import { favoritesFirst, useFavorites } from "@/hooks/useFavorites";
import { useVoicePreview } from "@/hooks/useVoicePreview";
import { api, estimateSeconds, formatSeconds, isDarkHex, wordCount } from "@/lib/client";
import { languageLabel } from "@/lib/language";
import { portraitSvg } from "@/lib/stock";
import { findTemplate } from "@/lib/templates";
import { CAPTION_POSITIONS, CAPTION_SIZES, DEFAULT_CAPTION_STYLE, DEFAULT_LAYOUT, MAX_SCENES, RESOLUTIONS, isDefaultCaptionStyle as isDefaultCaptionStyleFn, type AspectRatio, type AudioClip, type Avatar, type Background, type BrandKit, type CaptionStyle, type Resolution, type Scene, type SceneLayout, type Video, type VideoTemplate, type Voice } from "@/lib/types";

const BG_PRESETS = ["#f1f5f9", "#ffffff", "#0f172a", "#1e3a8a", "#4f46e5", "#065f46", "#7c2d12", "#be123c"];
const DEFAULT_BG: Background = { type: "color", value: "#f1f5f9" };
const DRAFT_KEY = "avatar-studio:draft";

interface Draft {
  title: string;
  scenes: Scene[];
  aspect: AspectRatio;
  resolution?: Resolution;
  captions: boolean;
  captionStyle?: CaptionStyle;
  speed: number;
  pitch?: number;
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
const newScene = (script = "", background: Background = DEFAULT_BG, presenter: Pick<Scene, "avatarId" | "voiceId" | "layout" | "audioId"> = {}): Scene => ({
  script,
  background,
  ...(presenter.avatarId ? { avatarId: presenter.avatarId } : {}),
  ...(presenter.voiceId && !presenter.audioId ? { voiceId: presenter.voiceId } : {}),
  ...(presenter.layout ? { layout: presenter.layout } : {}),
  ...(presenter.audioId ? { audioId: presenter.audioId } : {}),
});
/** True when a layout is the renderer's default and need not be stored. */
const isDefaultLayout = (l: SceneLayout) => l.scale === 1 && l.x === 0 && l.y === 0;
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
  const { data: clipData, error: clipsError, setData: setClipData } = useApi<{ clips: AudioClip[] }>("/api/clips");
  const clips = clipData?.clips ?? [];
  const { play, playingId, busyId } = useVoicePreview();

  const [title, setTitle] = useState("Untitled video");
  const [scenes, setScenes] = useState<Scene[]>([newScene()]);
  const [activeIdx, setActiveIdx] = useState(0);
  const active = scenes[Math.min(activeIdx, scenes.length - 1)];
  const script = scenes.map((s) => s.script).join("\n\n");
  const background = active.background;
  const setScript = (value: string) => updateScene(activeIdx, { script: value });
  const scriptRef = useRef<HTMLTextAreaElement>(null);
  /** Puts a one-second pause marker at the cursor (or over the selection), spaced off from the words around it. */
  function insertPause() {
    const el = scriptRef.current;
    const text = active.script;
    const start = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : start;
    const before = text.slice(0, start);
    const after = text.slice(end);
    // A space after the marker unless one follows already, so typing carries on as a new word.
    const marker = `${before && !/\s$/.test(before) ? " " : ""}[pause 1s]${/^\s/.test(after) ? "" : " "}`;
    if ((before + marker + after).length > 5000) return;
    setScript(before + marker + after);
    const at = before.length + marker.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  }
  const setBackground = (value: Background) => updateScene(activeIdx, { background: value });
  const layout: SceneLayout = active.layout ?? DEFAULT_LAYOUT;
  // The default layout is stored as absent, so an untouched scene renders exactly as before.
  const setLayout = (value: SceneLayout) => updateScene(activeIdx, { layout: isDefaultLayout(value) ? undefined : value });
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
  /** Swaps a scene with its neighbour and keeps it selected. */
  function moveScene(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= scenes.length) return;
    setScenes((prev) => {
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
    setActiveIdx(j);
  }
  /** Inserts a copy right after the scene (script, background, and presenter included) and selects it. */
  function duplicateScene(idx: number) {
    if (scenes.length >= MAX_SCENES) return;
    setScenes((prev) => [...prev.slice(0, idx + 1), { ...prev[idx] }, ...prev.slice(idx + 1)]);
    setActiveIdx(idx + 1);
  }
  const [avatar, setAvatar] = useState<Avatar | null>(null);
  const [voice, setVoice] = useState<Voice | null>(null);
  /** An explicit pick in the Avatar tab; a photo avatar with a default voice brings that voice along. */
  function pickAvatar(a: Avatar) {
    setAvatar(a);
    const preferred = a.defaultVoiceId ? voiceData?.voices.find((v) => v.id === a.defaultVoiceId) : undefined;
    if (preferred) setVoice(preferred);
  }
  // A scene may name its own presenter and voice; otherwise it uses the video's.
  const sceneAvatar = (active.avatarId && avatarData?.avatars.find((a) => a.id === active.avatarId)) || avatar;
  const sceneVoice = (active.voiceId && voiceData?.voices.find((v) => v.id === active.voiceId)) || voice;
  // A scene's presenter or voice may have been deleted since the draft or the original video was
  // saved; once the lists are known, drop ids they no longer contain so the scene really does use
  // the video's choice (which is what the selects would otherwise claim) instead of failing to render.
  useEffect(() => {
    // Clips that failed to load are not treated as deleted: the scene keeps its clip and the server decides.
    if (!avatarData || !voiceData || (!clipData && !clipsError)) return;
    const avatars = new Set(avatarData.avatars.map((a) => a.id));
    const voices = new Set(voiceData.voices.map((v) => v.id));
    const clipIds = clipData ? new Set(clipData.clips.map((c) => c.id)) : null;
    setScenes((prev) => {
      let changed = false;
      const next = prev.map((sc) => {
        const dropAvatar = !!sc.avatarId && !avatars.has(sc.avatarId);
        const dropVoice = !!sc.voiceId && !voices.has(sc.voiceId);
        // A clip deleted since the draft or the copied video was saved: the scene goes back to a voice.
        const dropAudio = !!sc.audioId && !!clipIds && !clipIds.has(sc.audioId);
        if (!dropAvatar && !dropVoice && !dropAudio) return sc;
        changed = true;
        return newScene(sc.script, sc.background, { avatarId: dropAvatar ? undefined : sc.avatarId, voiceId: dropVoice ? undefined : sc.voiceId, layout: sc.layout, audioId: dropAudio ? undefined : sc.audioId });
      });
      return changed ? next : prev;
    });
  }, [avatarData, voiceData, clipData, clipsError, scenes]);
  const [aspect, setAspect] = useState<AspectRatio>("16:9");
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [captions, setCaptions] = useState(false);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(DEFAULT_CAPTION_STYLE);
  const isDefaultCaptionStyle = isDefaultCaptionStyleFn(captionStyle);
  const [speed, setSpeed] = useState(1);
  const [pitch, setPitch] = useState(0);
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
    setScenes(d.scenes.map((sc) => newScene(sc.script, sc.background, sc)));
    setActiveIdx(0);
    setAspect(d.aspect);
    setResolution(d.resolution ?? "1080p");
    setCaptions(d.captions);
    setCaptionStyle(d.captionStyle ?? DEFAULT_CAPTION_STYLE);
    setSpeed(d.speed);
    setPitch(d.pitch ?? 0);
    setPrefill({ avatarId: d.avatarId, voiceId: d.voiceId });
    setDraftRestored(d.savedAt);
  }, [templateId, fromId]);

  // Autosave the editor state (debounced) so a refresh never loses work.
  useEffect(() => {
    if (!hydrated.current) return;
    const empty = scenes.every((sc) => !sc.script.trim()) && title === "Untitled video";
    const t = setTimeout(() => {
      writeDraft(empty ? null : { title, scenes, aspect, resolution, captions, ...(isDefaultCaptionStyle ? {} : { captionStyle }), speed, ...(pitch ? { pitch } : {}), avatarId: avatar?.id, voiceId: voice?.id, savedAt: new Date().toISOString() });
    }, 400);
    return () => clearTimeout(t);
  }, [title, scenes, aspect, resolution, captions, captionStyle, isDefaultCaptionStyle, speed, pitch, avatar, voice]);

  function discardDraft() {
    writeDraft(null);
    setTitle("Untitled video");
    setScenes([newScene()]);
    setActiveIdx(0);
    setAspect("16:9");
    setResolution("1080p");
    setCaptions(false);
    setSpeed(1);
    setPitch(0);
    setDraftRestored(null);
  }

  // Brand kit defaults for a fresh editor: avatar, voice, captions, and (without a template) aspect and background.
  // Restored drafts, copies, and saved templates keep what they had: a saved template carries its own
  // presenter, voice, captions, and quality, and loads at the same time as the kit.
  const brandApplied = useRef(false);
  useEffect(() => {
    if (brandApplied.current || !brandData) return;
    brandApplied.current = true;
    const b = brandData.brand;
    if (!b || fromId || draftRestored || templateId?.startsWith("tpl_")) return;
    if (b.captionsByDefault != null) setCaptions(b.captionsByDefault);
    if (b.defaultAvatarId || b.defaultVoiceId) setPrefill({ avatarId: b.defaultAvatarId, voiceId: b.defaultVoiceId });
    if (b.defaultResolution) setResolution(b.defaultResolution);
    if (templateId) return;
    if (b.defaultAspect) setAspect(b.defaultAspect);
    setScenes((prev) => prev.map((sc) => (sc.script.trim() ? sc : { ...sc, background: b.defaultBackground ?? { type: "color", value: b.primaryColor } })));
  }, [brandData, fromId, templateId, draftRestored]);

  // Pre-fill from a template (?template=) or an existing video (?from=).
  useEffect(() => {
    const t = findTemplate(templateId);
    if (t) {
      setTitle(t.title);
      setScenes([newScene(t.script)]);
      setActiveIdx(0);
      setAspect(t.aspect);
      return;
    }
    // A saved template (tpl_…) brings its scenes, presenter, voice, and settings.
    if (!templateId?.startsWith("tpl_")) return;
    let cancelled = false;
    api<{ template: VideoTemplate }>(`/api/templates/${templateId}`)
      .then(({ template }) => {
        if (cancelled) return;
        setTitle(template.title);
        setScenes(template.scenes.map((sc) => newScene(sc.script, sc.background, sc)));
        setActiveIdx(0);
        setAspect(template.aspect);
        setResolution(template.resolution ?? "1080p");
        setCaptions(template.captions);
        setCaptionStyle(template.captionStyle ?? DEFAULT_CAPTION_STYLE);
        setSpeed(template.speed);
        setPitch(template.pitch ?? 0);
        setPrefill({ avatarId: template.avatarId, voiceId: template.voiceId });
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not load the template"));
    return () => {
      cancelled = true;
    };
  }, [templateId]);
  useEffect(() => {
    if (!fromId) return;
    api<{ video: Video }>(`/api/videos/${fromId}`)
      .then(({ video }) => {
        setTitle(`${video.title} (copy)`);
        setScenes(video.scenes?.length ? video.scenes.map((sc) => newScene(sc.script, sc.background, sc)) : [newScene(video.script, video.background)]);
        setActiveIdx(0);
        setAspect(video.aspect);
        setResolution(video.resolution ?? "1080p");
        setCaptions(video.captions);
        setCaptionStyle(video.captionStyle ?? DEFAULT_CAPTION_STYLE);
        setSpeed(video.speed);
        setPitch(video.pitch ?? 0);
        setPrefill({ avatarId: video.avatarId, voiceId: video.voiceId });
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not load the original video"));
  }, [fromId]);

  // Default selections once data arrives: the first avatar, and its default voice if it has one
  // (a draft, template, copy, or brand kit applied below overrides both).
  useEffect(() => {
    if (!avatar && avatarData?.avatars.length) setAvatar(avatarData.avatars[0]);
  }, [avatarData, avatar]);
  useEffect(() => {
    // Wait for the avatar list (or its failure) so the first avatar's default voice wins whichever list lands first.
    if (voice || !voiceData?.voices.length || avatarsLoading) return;
    const first = avatar ?? avatarData?.avatars[0];
    setVoice((first?.defaultVoiceId && voiceData.voices.find((v) => v.id === first.defaultVoiceId)) || voiceData.voices[0]);
  }, [voiceData, voice, avatar, avatarData, avatarsLoading]);
  // Apply a copied video's avatar/voice once both lists are loaded, then clear the prefill. A saved
  // voice that is gone (a deleted clone, another voice provider) gives way to the presenter's own default.
  useEffect(() => {
    if (!prefill || !avatarData || !voiceData) return;
    const a = avatarData.avatars.find((x) => x.id === prefill.avatarId);
    const v = voiceData.voices.find((x) => x.id === prefill.voiceId) ?? (a?.defaultVoiceId ? voiceData.voices.find((x) => x.id === a.defaultVoiceId) : undefined);
    if (a) setAvatar(a);
    if (v) setVoice(v);
    setPrefill(null);
  }, [prefill, avatarData, voiceData]);

  const favorites = useFavorites();
  const avatarsSorted = useMemo(() => favoritesFirst(avatarData?.avatars ?? [], favorites.avatarIds), [avatarData, favorites.avatarIds]);
  const [voiceLanguage, setVoiceLanguage] = useState("all");
  const voiceLanguages = useMemo(() => {
    const seen = new Map<string, string>();
    for (const v of voiceData?.voices ?? []) if (v.language && !seen.has(v.language)) seen.set(v.language, languageLabel(v.language));
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [voiceData]);
  const voices = useMemo(() => {
    const all = voiceData?.voices ?? [];
    const q = voiceQuery.trim().toLowerCase();
    const matching = all.filter((v) => (voiceLanguage === "all" || v.language === voiceLanguage) && (!q || [v.name, v.language, v.gender, ...(v.tags ?? [])].filter(Boolean).join(" ").toLowerCase().includes(q)));
    return favoritesFirst(matching, favorites.voiceIds);
  }, [voiceData, voiceQuery, voiceLanguage, favorites.voiceIds]);

  const words = wordCount(script);
  /** A typed scene lasts as long as its words take at the chosen speed; an audio scene as long as its clip. */
  const sceneSeconds = (sc: Scene) => {
    const clip = sc.audioId ? clips.find((c) => c.id === sc.audioId) : undefined;
    return clip ? Math.round(clip.durationSec) : estimateSeconds(sc.script, speed);
  };
  // Typed scenes are estimated together, as before audio scenes existed, so short scenes are not each rounded up.
  const seconds =
    scenes.reduce((sum, sc) => sum + (sc.audioId ? sceneSeconds(sc) : 0), 0) +
    estimateSeconds(scenes.filter((sc) => !sc.audioId).map((sc) => sc.script).join("\n\n"), speed);
  const allScenesFilled = scenes.every((sc) => sc.script.trim().length > 0);
  const canEdit = useCanEdit();
  const canGenerate = canEdit !== false && !!avatar && !!voice && allScenesFilled && title.trim().length > 0 && !submitting;

  async function generate() {
    if (!avatar || !voice) return;
    setSubmitting(true);
    setErr(null);
    try {
      const { video } = await api<{ video: Video }>("/api/videos", {
        method: "POST",
        body: JSON.stringify({ title, scenes, avatarId: avatar.id, voiceId: voice.id, aspect, resolution, captions, ...(captions && !isDefaultCaptionStyle ? { captionStyle } : {}), speed, ...(pitch ? { pitch } : {}) }),
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
  }, [canGenerate, title, scenes, avatar, voice, aspect, captions, captionStyle, isDefaultCaptionStyle, speed, pitch]);

  const stageAspect = aspect === "9:16" ? "aspect-[9/16]" : aspect === "1:1" ? "aspect-square" : "aspect-video";
  const bgIsDark = (background.type === "color" && isDarkHex(background.value)) || background.type === "video";

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
      {canEdit === false && <ViewOnlyNotice what="generate videos" />}
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
        {/* Left column: stage + script. min-w-0 lets the columns shrink below their content width on phones. */}
        <div className="min-w-0 space-y-5">
          <input className={`${inputClass} text-base font-medium`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Video title" />

          <Card className="overflow-hidden">
            <div data-testid="stage" className={`relative mx-auto w-full ${stageAspect} ${aspect === "9:16" ? "max-h-[520px]" : ""} flex items-end justify-center overflow-hidden`} style={background.type === "color" ? { background: background.value } : background.type === "image" ? { backgroundImage: `url(${background.value})`, backgroundSize: "cover", backgroundPosition: "center" } : { background: "#0f172a" }}>
              {/* Only a complete URL is previewed, so a half-typed one is not requested keystroke by keystroke. */}
              {background.type === "video" && /^https?:\/\/\S+\.\S+/.test(background.value) && (
                <video key={background.value} src={background.value} muted loop autoPlay playsInline aria-hidden="true" data-testid="stage-video" className="absolute inset-0 h-full w-full object-cover" />
              )}
              {sceneAvatar ? (
                // The offset moves a frame-sized layer so one unit is half the frame on either axis; the scale stays on the portrait.
                <div data-testid="stage-presenter" className="absolute inset-0 flex items-end justify-center" style={{ transform: `translate(${layout.x * 50}%, ${layout.y * 50}%)` }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                  data-testid="stage-avatar"
                  src={sceneAvatar.imageUrl}
                  alt={sceneAvatar.name}
                  className={`${aspect === "16:9" ? "h-[92%]" : "h-[80%]"} max-w-[80%] object-contain object-bottom drop-shadow-xl`}
                  style={{ transform: `scale(${layout.scale})`, transformOrigin: "bottom center" }}
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (!img.dataset.fallback) {
                      img.dataset.fallback = "1";
                      img.src = portraitSvg(sceneAvatar.name, sceneAvatar.name.length);
                    }
                  }}
                />
                </div>
              ) : (
                <Skeleton className="h-3/4 w-1/3" />
              )}
              {captions && active.script.trim() && (
                <div
                  data-testid="stage-caption"
                  className={`absolute ${captionStyle.position === "top" ? "top-4" : "bottom-4"} left-1/2 max-w-[85%] -translate-x-1/2 rounded-md px-3 py-1.5 text-center font-medium ${captionStyle.size === "small" ? "text-xs" : captionStyle.size === "large" ? "text-lg" : "text-sm"} ${bgIsDark ? "bg-white/90 text-slate-900" : "bg-black/80 text-white"}`}
                >
                  {active.script.trim().split(/(?<=[.!?])\s+/)[0].slice(0, 90)}
                </div>
              )}
              <span className={`absolute left-3 ${captions && captionStyle.position === "top" ? "bottom-3" : "top-3"} rounded px-2 py-0.5 text-[11px] font-medium ${bgIsDark ? "bg-white/15 text-white" : "bg-black/10 text-slate-800"}`}>
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
                  aria-label={`Scene ${i + 1}${sc.script.trim() ? `, about ${formatSeconds(Math.max(1, sceneSeconds(sc)))}` : ", empty"}`}
                  aria-current={i === activeIdx ? "true" : undefined}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                    i === activeIdx ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <span className="h-2.5 w-2.5 rounded-full border border-black/10" style={sc.background.type === "color" ? { background: sc.background.value } : sc.background.type === "video" ? { background: "linear-gradient(135deg,#0f172a,#475569)" } : { background: "linear-gradient(135deg,#94a3b8,#cbd5e1)" }} />
                  {i + 1}
                  {sc.script.trim() ? (
                    <span className="font-normal text-slate-400" data-testid="scene-duration">{sc.audioId ? "" : "~"}{formatSeconds(Math.max(1, sceneSeconds(sc)))}</span>
                  ) : (
                    <span className="text-amber-500" title="Empty scene">•</span>
                  )}
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
              <span className="ml-auto flex items-center gap-1">
                {scenes.length > 1 && (
                  <>
                    <button type="button" onClick={() => moveScene(activeIdx, -1)} disabled={activeIdx === 0} aria-label="Move scene left" title="Move scene earlier" className="rounded-full p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => moveScene(activeIdx, 1)} disabled={activeIdx === scenes.length - 1} aria-label="Move scene right" title="Move scene later" className="rounded-full p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </>
                )}
                <button type="button" onClick={() => duplicateScene(activeIdx)} disabled={scenes.length >= MAX_SCENES} aria-label="Duplicate scene" title="Duplicate this scene" className="rounded-full p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
                  <Copy className="h-4 w-4" />
                </button>
                {scenes.length > 1 && (
                  <button type="button" onClick={() => removeScene(activeIdx)} aria-label="Remove scene" className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-slate-500 hover:bg-rose-50 hover:text-rose-600">
                    <Trash2 className="h-3.5 w-3.5" /> Remove scene {activeIdx + 1}
                  </button>
                )}
              </span>
            </div>
            {scenes.length > 1 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="scene-presenter">
                <span className="font-medium">Scene {activeIdx + 1} presenter</span>
                <select aria-label="Scene avatar" className={`${inputClass} w-auto py-1 text-xs`} value={active.avatarId ?? ""} onChange={(e) => {
                  const picked = avatarData?.avatars.find((a) => a.id === e.target.value);
                  // A presenter's default voice comes along unless the scene already has a voice of its own.
                  const voiceId = picked?.defaultVoiceId && !active.voiceId && voiceData?.voices.some((v) => v.id === picked.defaultVoiceId) ? picked.defaultVoiceId : active.voiceId;
                  updateScene(activeIdx, { avatarId: e.target.value || undefined, voiceId });
                }}>
                  <option value="">{avatar ? `Video avatar (${avatar.name})` : "Video avatar"}</option>
                  {(avatarData?.avatars ?? []).map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                {!active.audioId && (
                  <select aria-label="Scene voice" className={`${inputClass} w-auto py-1 text-xs`} value={active.voiceId ?? ""} onChange={(e) => updateScene(activeIdx, { voiceId: e.target.value || undefined })}>
                    <option value="">{voice ? `Video voice (${voice.name})` : "Video voice"}</option>
                    {(voiceData?.voices ?? []).map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )}
            <details className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="scene-layout">
              <summary className="cursor-pointer select-none font-medium text-slate-700">
                Presenter layout{isDefaultLayout(layout) ? "" : ` · ${Math.round(layout.scale * 100)}%${layout.x || layout.y ? ", moved" : ""}`}
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block">Size · {Math.round(layout.scale * 100)}%</span>
                  <input type="range" aria-label="Presenter size" min={0.5} max={1.5} step={0.05} value={layout.scale} onChange={(e) => setLayout({ ...layout, scale: Number(e.target.value) })} className="w-full accent-brand-600" />
                </label>
                <label className="block">
                  <span className="mb-1 block">Horizontal · {Math.round(layout.x * 100)}</span>
                  <input type="range" aria-label="Presenter horizontal position" min={-1} max={1} step={0.05} value={layout.x} onChange={(e) => setLayout({ ...layout, x: Number(e.target.value) })} className="w-full accent-brand-600" />
                </label>
                <label className="block">
                  <span className="mb-1 block">Vertical · {Math.round(layout.y * 100)}</span>
                  <input type="range" aria-label="Presenter vertical position" min={-1} max={1} step={0.05} value={layout.y} onChange={(e) => setLayout({ ...layout, y: Number(e.target.value) })} className="w-full accent-brand-600" />
                </label>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-slate-500">Applies to this scene. HeyGen renders the size and position; other renderers use their default.</span>
                {!isDefaultLayout(layout) && (
                  <button type="button" onClick={() => setLayout(DEFAULT_LAYOUT)} className="text-brand-700 hover:underline">
                    Reset
                  </button>
                )}
              </div>
            </details>
            <SceneAudio
              // Distinct from the script box's key: both sit among the same siblings.
              key={`audio-${activeIdx}`}
              clips={clips}
              clipId={active.audioId}
              disabled={canEdit === false}
              onUse={(clip) => updateScene(activeIdx, { audioId: clip.id, voiceId: undefined })}
              onClear={() => updateScene(activeIdx, { audioId: undefined })}
              onSaved={(clip) => setClipData((prev) => ({ clips: [clip, ...(prev?.clips ?? []).filter((c) => c.id !== clip.id)] }))}
            />
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">
                {active.audioId ? (scenes.length > 1 ? `Scene ${activeIdx + 1}: what the clip says` : "What the clip says") : scenes.length > 1 ? `Scene ${activeIdx + 1} script` : "Script"}
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500" data-testid="script-length">
                  {scenes.length > 1
                    ? `${wordCount(active.script)} words · ~${formatSeconds(sceneSeconds(active))} this scene · ~${formatSeconds(seconds)} total`
                    : `${words} words · ~${formatSeconds(seconds)}`}
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
                {!active.audioId && (
                  <Button variant="secondary" className="px-3 py-1.5" onClick={insertPause} disabled={canEdit === false} title="Insert a pause at the cursor; change the number to make it longer (up to 10 seconds)">
                    <Pause className="h-4 w-4" /> Pause
                  </Button>
                )}
                {sceneVoice && !active.audioId && (
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5"
                    disabled={!active.script.trim()}
                    loading={busyId === sceneVoice.id}
                    onClick={() => play(sceneVoice, active.script.slice(0, 400), speed).catch((e) => setErr(e.message))}
                  >
                    {playingId === sceneVoice.id ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {playingId === sceneVoice.id ? "Stop" : "Listen"}
                  </Button>
                )}
              </div>
            </div>
            {writerOpen && <ScriptWriter onClose={() => setWriterOpen(false)} onScript={(s) => { setScript(s); setWriterOpen(false); }} />}
            <textarea
              ref={scriptRef}
              aria-label={scenes.length > 1 ? `Scene ${activeIdx + 1} script` : "Script"}
              key={activeIdx}
              className={`${inputClass} min-h-[220px] resize-y leading-relaxed`}
              value={active.script}
              onChange={(e) => setScript(e.target.value)}
              placeholder={active.audioId ? "Type what the clip says. It becomes the captions and makes the video searchable." : scenes.length > 1 ? `What the avatar says in scene ${activeIdx + 1}.` : "Type what your avatar should say, or click “Write with AI”."}
              maxLength={5000}
            />
          </Card>
        </div>

        {/* Right column: configuration tabs */}
        <Card className="flex min-w-0 max-h-[calc(100vh-11rem)] flex-col">
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
                className={`flex min-w-0 flex-1 items-center justify-center gap-1 px-1 py-3 text-xs font-medium sm:gap-2 sm:px-3 sm:text-sm ${tab === key ? "border-b-2 border-brand-600 text-brand-700" : "text-slate-500 hover:text-slate-900"}`}
              >
                <Icon className="h-4 w-4 shrink-0" /> {label}
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
                <AvatarGrid avatars={avatarsSorted} selectedId={avatar?.id} onSelect={pickAvatar} compact favoriteIds={favorites.avatarIds} onToggleFavorite={(a) => favorites.toggle("avatar", a.id)} />
              )
            )}

            {tab === "voice" && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input className={inputClass} placeholder="Search voices" value={voiceQuery} onChange={(e) => setVoiceQuery(e.target.value)} />
                  {voiceLanguages.length > 1 && (
                    <select aria-label="Voice language" value={voiceLanguage} onChange={(e) => setVoiceLanguage(e.target.value)} className={`${inputClass} w-auto max-w-[45%]`}>
                      <option value="all">All languages</option>
                      {voiceLanguages.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </select>
                  )}
                </div>
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
                        favorite={favorites.voiceIds.has(v.id)}
                        onToggleFavorite={() => favorites.toggle("voice", v.id)}
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
                <Field label="Video URL" hint="A public MP4 or WebM URL that loops behind the avatar. HeyGen plays it; other renderers use their default background.">
                  <div className="flex gap-2">
                    <input
                      className={inputClass}
                      placeholder="https://…/background.mp4"
                      value={background.type === "video" ? background.value : ""}
                      onChange={(e) => setBackground(e.target.value ? { type: "video", value: e.target.value } : DEFAULT_BG)}
                    />
                    <span className="flex items-center text-slate-400"><Clapperboard className="h-5 w-5" /></span>
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
                <div>
                  <div className="mb-2 text-sm font-medium text-slate-700">Output quality</div>
                  <div className="grid grid-cols-2 gap-2">
                    {RESOLUTIONS.map((r) => (
                      <button
                        key={r}
                        type="button"
                        aria-pressed={resolution === r}
                        onClick={() => setResolution(r)}
                        className={`rounded-lg border px-3 py-3 text-sm font-medium ${resolution === r ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}
                      >
                        {r}
                        <div className="text-[11px] font-normal text-slate-500">{r === "720p" ? "HD · faster, smaller file" : "Full HD · best quality"}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <Field label={`Speaking speed · ${speed.toFixed(2)}x`}>
                  <input type="range" min={0.5} max={1.5} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full accent-brand-600" />
                </Field>
                <Field label={`Voice pitch · ${pitch > 0 ? `+${pitch}` : pitch === 0 ? "natural" : pitch}`} hint="HeyGen shifts the voice up or down; other renderers keep its natural pitch.">
                  <input type="range" min={-50} max={50} step={5} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} aria-label="Voice pitch" className="w-full accent-brand-600" />
                </Field>
                <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-3">
                  <span>
                    <span className="block text-sm font-medium text-slate-800">Captions</span>
                    <span className="block text-xs text-slate-500">Burn subtitles into the video.</span>
                  </span>
                  <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} className="h-5 w-5 accent-brand-600" />
                </label>
                {captions && (
                  <div className="rounded-lg border border-slate-200 px-3 py-3" data-testid="caption-style">
                    <div className="text-sm font-medium text-slate-800">Caption style</div>
                    <div className="mt-0.5 text-xs text-slate-500">Where subtitles sit and how big they read in the share page's subtitle track and the subtitle file. A renderer that burns captions into the video leaves them off, so this look is the only one and the downloaded file carries no captions.</div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <div role="group" aria-label="Caption position" className="flex gap-1">
                        {CAPTION_POSITIONS.map((pos) => (
                          <button key={pos} type="button" aria-pressed={captionStyle.position === pos} onClick={() => setCaptionStyle({ ...captionStyle, position: pos })} className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium capitalize ${captionStyle.position === pos ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}>
                            {pos}
                          </button>
                        ))}
                      </div>
                      <div role="group" aria-label="Caption size" className="flex gap-1">
                        {CAPTION_SIZES.map((size) => (
                          <button key={size} type="button" aria-pressed={captionStyle.size === size} onClick={() => setCaptionStyle({ ...captionStyle, size })} className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium capitalize ${captionStyle.size === size ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}>
                            {size}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
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

