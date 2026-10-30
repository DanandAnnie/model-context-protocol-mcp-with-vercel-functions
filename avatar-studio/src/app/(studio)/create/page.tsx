"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { Captions, ChevronLeft, ChevronRight, Clapperboard, Copy, Flag, Image as ImageIcon, Layers, Merge, MessagesSquare, Mic2, Palette, Pause, Play, Plus, Redo2, Replace, Scissors, Sparkles, Square, Trash2, Undo2, Upload, Users, Wand2, X } from "lucide-react";
import { AvatarGrid } from "@/components/AvatarPicker";
import { VoiceRow } from "@/components/VoicePicker";
import { Button, Card, ErrorBanner, Field, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { SceneAudio } from "@/components/SceneAudio";
import { BackdropPicker } from "@/components/BackdropPicker";
import { CONVERSATION_PANEL_ID, ConversationImport, type CastTurn } from "@/components/ConversationImport";
import { isApple } from "@/components/QuickFind";
import { favoritesFirst, useFavorites } from "@/hooks/useFavorites";
import { useVoicePreview } from "@/hooks/useVoicePreview";
import { api, estimateSeconds, formatSeconds, isDarkHex, wordCount } from "@/lib/client";
import { accentsFor, languageLabel, voiceTakesAccent } from "@/lib/language";
import { MAX_SILENT_SEC, MIN_SILENT_SEC, silentProblem, silentSeconds, stripPauses } from "@/lib/pauses";
import { countMatches, replaceAll } from "@/lib/find-replace";
import { MAX_IMPORT_BYTES, MAX_SCRIPT_CHARS, decodeScript, legacyEncodingFor, scenesFromText } from "@/lib/script-import";
import { renderPdf, slideScripts } from "@/lib/pdf-slides";
import { readPptx, type PptxSlide } from "@/lib/pptx-notes";
import { readDocx } from "@/lib/docx-text";
import { portraitSvg } from "@/lib/stock";
import { findTemplate } from "@/lib/templates";
import { capSceneText, fitSceneTextEdit, sceneTextLength } from "@/lib/scene-text";
import { mergeScenes, moveItem, splitScene } from "@/lib/scene-split";
import { emptyHistory, record, redo, undo, type History } from "@/lib/scene-history";
import { graphemes } from "@/lib/text";
import { takeAgentDraft, type AgentDraft } from "@/lib/agent-draft";
import { CAPTION_FONTS, CAPTION_LOOKS, CAPTION_POSITIONS, CAPTION_SIZES, DEFAULT_CAPTION_STYLE, DEFAULT_LAYOUT, MAX_SCENES, MAX_SCENE_TEXT, PRESENTER_FRAMINGS, RESOLUTIONS, SCENE_TEXT_POSITIONS, SCENE_TEXT_SCALE, SCENE_TEXT_SIZES, SCENE_TEXT_Y, sceneTextFits, isDefaultCaptionStyle as isDefaultCaptionStyleFn, MAX_BACKDROPS, backdropIdOf, backdropPath, footageIdOf, footageLength, footagePath, type FootageJob, framingFor, isDefaultLayout, isPhotoAvatar, rendersOnAvatarV, type PresenterFraming, type AspectRatio, type AudioClip, type Avatar, type Backdrop, type Background, type BrandKit, type CaptionFont, type CaptionLook, type CaptionStyle, type Resolution, type Scene, type SceneLayout, type SceneText, type Video, type VideoTemplate, type Voice, type VoiceEmotion, VOICE_EMOTIONS, MAX_MOTION_PROMPT, PHOTO_EXPRESSIVENESS, type PhotoExpressiveness, VOICE_ACCENTS, type VoiceAccent, AVATAR_ENGINES, type AvatarEngine } from "@/lib/types";

const BG_PRESETS = ["#f1f5f9", "#ffffff", "#0f172a", "#1e3a8a", "#4f46e5", "#065f46", "#7c2d12", "#be123c"];
const DEFAULT_BG: Background = { type: "color", value: "#f1f5f9" };
/** Where the personal space's draft is kept; a workspace's has its id after it (see `draftKeyFor`). */
const DRAFT_KEY = "avatar-studio:draft";
/** The drag type a scene tab carries: only another tab takes it (a text field does not). */
const SCENE_DRAG = "application/x-avatar-studio-scene";

/**
 * Each space keeps its own draft: one started in Personal never shows up, or loses its uploaded images, in a
 * workspace (the images are the space's own). Personal keeps the original key, so drafts saved before survive.
 */
function draftKeyFor(spaces: { personalId: string; activeId: string } | null): string | null {
  return spaces ? (spaces.activeId === spaces.personalId ? DRAFT_KEY : `${DRAFT_KEY}:${spaces.activeId}`) : null;
}

/** What a scene change can change: the scenes, and the video's presenter, voice, pace, and format. */
interface EditorState {
  scenes: Scene[];
  avatar: Avatar | null;
  voice: Voice | null;
  speed: number;
  aspect: AspectRatio;
}
const sameEditorState = (a: EditorState, b: EditorState) => a.scenes === b.scenes && a.avatar?.id === b.avatar?.id && a.voice?.id === b.voice?.id && a.speed === b.speed && a.aspect === b.aspect;

interface Draft {
  title: string;
  scenes: Scene[];
  aspect: AspectRatio;
  resolution?: Resolution;
  captions: boolean;
  captionStyle?: CaptionStyle;
  speed: number;
  pitch?: number;
  emotion?: VoiceEmotion;
  expressiveness?: PhotoExpressiveness;
  motionPrompt?: string;
  accent?: VoiceAccent;
  avatarEngine?: AvatarEngine;
  moreBlinking?: boolean;
  transparent?: boolean;
  avatarId?: string;
  voiceId?: string;
  savedAt: string;
}

function readDraft(key: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return Array.isArray(d.scenes) && d.scenes.length ? d : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string, d: Draft | null) {
  try {
    if (d) window.localStorage.setItem(key, JSON.stringify(d));
    else window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (private mode); drafts are a convenience only.
  }
}
/** Thrown when the user declines to replace the scenes once a deck's page count is known. */
class ImportCancelled extends Error {}

/** The paces a scene can take instead of the video's (the video's own speed is the default choice). */
const SCENE_SPEEDS = [0.75, 0.85, 0.9, 1, 1.1, 1.15, 1.25];

/** A deck larger than this is refused before pdf.js reads it. */
const MAX_PDF_BYTES = 50_000_000;
/** A PowerPoint file larger than this is refused before it is unpacked (its pictures and video count, though only its text is read). */
const MAX_PPTX_BYTES = 100_000_000;
const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** A Word file larger than this is refused before it is unpacked (its pictures count, though only its text is read). */
const MAX_DOCX_BYTES = 50_000_000;

/** Whether the scenes hold anything worth asking about before they are replaced: a script, a clip, a presenter, a layout, on-screen text, or more than one scene. */
const setUpScenes = (list: Scene[]) => list.length > 1 || list.some((sc) => sc.script.trim() || sc.audioId || sc.avatarId || sc.voiceId || sc.layout || sc.overlay?.text.trim());
/** Whether a scene holds anything a draft should keep: a script or on-screen text. */
const hasContent = (sc: Scene) => !!(sc.script.trim() || sc.overlay?.text.trim());

/**
 * The PowerPoint slides that match a PDF of the same deck page for page. PowerPoint leaves hidden slides out when it
 * saves as PDF, so they are dropped unless the PDF has a page for every slide. `matches` is false when the counts
 * still differ, and the notes are then paired by position as far as they go.
 */
function slidesForPages(slides: PptxSlide[], pages: number): { slides: PptxSlide[]; matches: boolean } {
  if (slides.length === pages) return { slides, matches: true };
  const shown = slides.filter((sl) => !sl.hidden);
  return { slides: shown, matches: shown.length === pages };
}

const newScene = (script = "", background: Background = DEFAULT_BG, presenter: Pick<Scene, "avatarId" | "voiceId" | "layout" | "audioId" | "speed" | "overlay" | "hidePresenter"> = {}): Scene => ({
  script,
  background,
  // Only a picture or video can stand in for the presenter.
  ...(presenter.hidePresenter === true && background.type !== "color" ? { hidePresenter: true as const } : {}),
  ...(presenter.avatarId ? { avatarId: presenter.avatarId } : {}),
  ...(presenter.voiceId && !presenter.audioId ? { voiceId: presenter.voiceId } : {}),
  ...(presenter.layout ? { layout: presenter.layout } : {}),
  ...(presenter.audioId ? { audioId: presenter.audioId } : {}),
  // A clip keeps its own pace.
  ...(presenter.speed && !presenter.audioId ? { speed: presenter.speed } : {}),
  ...(restoredOverlay(presenter.overlay) ? { overlay: restoredOverlay(presenter.overlay) } : {}),
});
/** A scene on a new background: a colour cannot fill the frame in the presenter's place, so the presenter comes back. */
const withBackground = (sc: Scene, background: Background): Scene => {
  if (background.type !== "color" || !sc.hidePresenter) return { ...sc, background };
  const { hidePresenter: _dropped, ...rest } = sc;
  return { ...rest, background };
};
/** The same colour (in any case), or the same picture or clip shown the same way (its fit is "cover" unless it says otherwise). */
const backgroundsMatch = (a: Background, b: Background) =>
  a.type === "color" || b.type === "color" ? a.type === b.type && a.value.toLowerCase() === b.value.toLowerCase() : a.type === b.type && a.value === b.value && (a.fit ?? "cover") === (b.fit ?? "cover");
/** A scene as it is sent: one without the presenter has neither a presenter of its own nor a layout for one. */
function sentScene(sc: Scene): Scene {
  if (!sc.hidePresenter) return sc;
  const { avatarId: _a, layout: _l, ...rest } = sc;
  return rest;
}
/** On-screen text from a draft, a copy, or a template: anything this build does not offer is dropped, and blank text is none. */
function restoredOverlay(o: SceneText | undefined): SceneText | undefined {
  if (!o || typeof o.text !== "string" || !o.text.trim()) return undefined;
  return {
    text: capSceneText(o.text),
    ...(o.position && o.position !== "top" && SCENE_TEXT_POSITIONS.includes(o.position) ? { position: o.position } : {}),
    ...(o.size && o.size !== "medium" && SCENE_TEXT_SIZES.includes(o.size) ? { size: o.size } : {}),
    ...(typeof o.color === "string" && /^#[0-9a-f]{6}$/i.test(o.color) && o.color.toLowerCase() !== "#ffffff" ? { color: o.color.toLowerCase() } : {}),
  };
}
const TEXT_POSITION_LABELS = { top: "Top", center: "Middle", bottom: "Bottom" } as const;
const TEXT_SIZE_LABELS = { small: "Small", medium: "Medium", large: "Large" } as const;
const FRAMING_LABELS: Record<PresenterFraming, string> = { full: "Full", closeUp: "Close-up", circle: "Circle" };
/** The same stacks the share player's captions use (globals.css), so the stage previews the chosen typeface. */
const CAPTION_FONT_STACKS: Record<CaptionFont, string> = {
  sans: "inherit",
  serif: 'Georgia, "Times New Roman", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
/** A scene layout from a draft another build saved: a framing this build does not offer is dropped and the size and offset kept in bounds. */
const clamp = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const restoredLayout = (l: SceneLayout | undefined): SceneLayout | undefined => {
  if (!l) return undefined;
  const framing = l.framing && PRESENTER_FRAMINGS.includes(l.framing) && l.framing !== "full" ? l.framing : undefined;
  const out: SceneLayout = { scale: clamp(l.scale, 0.5, 1.5, 1), x: clamp(l.x, -1, 1, 0), y: clamp(l.y, -1, 1, 0), ...(framing ? { framing } : {}) };
  return isDefaultLayout(out) ? undefined : out;
};
/** A caption style from a draft an older build saved: any value this build does not offer falls back to the default. */
const restoredCaptionStyle = (s: CaptionStyle): CaptionStyle =>
  withoutDefaults({
    position: CAPTION_POSITIONS.includes(s.position) ? s.position : DEFAULT_CAPTION_STYLE.position,
    size: CAPTION_SIZES.includes(s.size) ? s.size : DEFAULT_CAPTION_STYLE.size,
    look: s.look && CAPTION_LOOKS.includes(s.look) ? s.look : undefined,
    font: s.font && CAPTION_FONTS.includes(s.font) ? s.font : undefined,
  });
/** A caption style with the default look and font left out, as the server stores it. */
const withoutDefaults = ({ look, font, ...rest }: CaptionStyle): CaptionStyle => ({ ...rest, ...(look && look !== "classic" ? { look } : {}), ...(font && font !== "sans" ? { font } : {}) });
/** An expressiveness this build offers, or "low" (HeyGen's default) for anything else. */
const asExpressiveness = (v: unknown): PhotoExpressiveness => ((PHOTO_EXPRESSIVENESS as readonly unknown[]).includes(v) ? (v as PhotoExpressiveness) : "low");
/** A gesture description from a draft, a copy, or a template: a string within the limit, or none. */
const asMotionPrompt = (v: unknown): string => (typeof v === "string" ? v.slice(0, MAX_MOTION_PROMPT) : "");
/** An accent this build offers, or "" (the voice's own) for anything else. */
const asAccent = (v: unknown): VoiceAccent | "" => ((VOICE_ACCENTS as readonly unknown[]).includes(v) ? (v as VoiceAccent) : "");
/** An engine this build offers, or "avatar_iv" (HeyGen's default) for anything else. */
const asAvatarEngine = (v: unknown): AvatarEngine => ((AVATAR_ENGINES as readonly unknown[]).includes(v) ? (v as AvatarEngine) : "avatar_iv");
/** An emotion the renderer takes, or "" (natural) for anything else. */
const asEmotion = (v: unknown): VoiceEmotion | "" => ((VOICE_EMOTIONS as readonly unknown[]).includes(v) ? (v as VoiceEmotion) : "");
const TONES = ["friendly", "professional", "formal", "energetic", "calm"] as const;
type Tab = "avatar" | "voice" | "background" | "settings";

/**
 * The stage preview's take on each caption look, weight included (one weight class per look, so none fights another).
 * "classic" follows the background so it stays readable; "minimal" adds a faint box on a light stage for contrast.
 */
function stageLook(look: CaptionLook, bgIsDark: boolean): string {
  switch (look) {
    case "bold":
      return "bg-black text-white font-bold";
    case "yellow":
      return "bg-black/75 text-yellow-400 font-semibold";
    case "minimal":
      return `${bgIsDark ? "bg-transparent" : "bg-black/40"} text-white font-medium [text-shadow:0_0_2px_#000,0_0_6px_#000,0_1px_3px_#000]`;
    default:
      return `font-medium ${bgIsDark ? "bg-white/90 text-slate-900" : "bg-black/80 text-white"}`;
  }
}

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
  // Uploaded background images; the picker adds and removes them here, so the list is always the editor's.
  const { data: backdropData, error: backdropError, setData: setBackdropData } = useApi<{ backdrops: Backdrop[] }>("/api/backdrops");
  // Generated clips (the B-roll page) a scene can loop as its video background; only finished ones are offered.
  const { data: footageData, refetch: refetchFootage } = useApi<{ footage: Array<Pick<FootageJob, "id" | "title" | "status" | "durationSec" | "autoLength" | "aspect">>; available: boolean }>("/api/footage");
  const readyFootage = (footageData?.footage ?? []).filter((f) => f.status === "completed");
  const { play, playingId, busyId } = useVoicePreview();

  const [title, setTitle] = useState("Untitled video");
  const [scenes, setScenes] = useState<Scene[]>([newScene()]);
  const [activeIdx, setActiveIdx] = useState(0);
  // The scene selected now, for answers that arrive after the user may have moved on.
  const activeIdxNow = useRef(activeIdx);
  activeIdxNow.current = activeIdx;
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
  // Another picture or video keeps the scene's fit; the Fit buttons set it.
  const setBackground = (value: Background) =>
    updateScene(activeIdx, { background: value.type !== "color" && background.type !== "color" && background.fit && !value.fit ? { ...value, fit: background.fit } : value });
  const layout: SceneLayout = active.layout ?? DEFAULT_LAYOUT;
  // The default layout is stored as absent, so an untouched scene renders exactly as before.
  const setLayout = (value: SceneLayout) => updateScene(activeIdx, { layout: isDefaultLayout(value) ? undefined : value });
  // Every set of words each clip has had while the editor is open: a scene filled with a clip's earlier words is still
  // filled with the clip's words after another scene keeps new ones.
  const clipWordsSeen = useRef(new Map<string, Set<string>>());
  for (const c of clips) {
    if (!c.transcript?.trim()) continue;
    const seen = clipWordsSeen.current.get(c.id) ?? new Set<string>();
    seen.add(c.transcript.trim());
    clipWordsSeen.current.set(c.id, seen);
  }
  /** True when a scene's script is exactly words its clip has said, rather than words typed for it alone. */
  const clipWords = (sc: Scene) => !!sc.audioId && !!sc.script.trim() && !!clipWordsSeen.current.get(sc.audioId)?.has(sc.script.trim());
  function updateScene(idx: number, patch: Partial<Scene>) {
    setScenes((prev) => {
      // A choice that changes nothing (the colour or framing already picked) leaves the scenes as they are, so it never
      // counts as an edit made since a scene change.
      const sc = prev[idx];
      if (!sc || Object.entries(patch).every(([k, v]) => JSON.stringify(v) === JSON.stringify(sc[k as keyof Scene]))) return prev;
      return prev.map((s, i) => (i === idx ? withBackground({ ...s, ...patch }, patch.background ?? s.background) : s));
    });
  }
  // Scene changes (added, removed, moved, duplicated, split, merged, imported, one background given to all) can be undone and redone, with what they
  // changed of the video's own settings; typing is left to the text box's own undo.
  const [sceneHistory, setSceneHistory] = useState<History<EditorState>>(emptyHistory);
  // The video's settings a scene change can touch, as they are now (set where they are declared, below).
  const videoNow = useRef<Omit<EditorState, "scenes">>({ avatar: null, voice: null, speed: 1, aspect: "16:9" });
  const editorNow = (): EditorState => ({ scenes: scenesNow.current, ...videoNow.current });
  /**
   * Replaces the scenes as an action that can be undone, named as the Undo button says it ("remove scene 3"), with any
   * of the video's settings the action changes. A lone scene's pace becomes the video's here (as the effect below does
   * for a loaded one), so what is recorded is what the editor shows.
   */
  function changeScenes(label: string, next: Scene[], options: { active?: number; avatar?: Avatar; voice?: Voice; aspect?: AspectRatio } = {}) {
    const before = editorNow();
    const lone = next.length === 1 && next[0].speed ? next[0].speed : undefined;
    const after: EditorState = {
      scenes: lone ? [{ ...next[0], speed: undefined }] : next,
      avatar: options.avatar ?? before.avatar,
      voice: options.voice ?? before.voice,
      speed: lone ?? before.speed,
      aspect: options.aspect ?? before.aspect,
    };
    setSceneHistory((h) => record(h, { label, before, after }));
    applyEditorState(after);
    if (options.active !== undefined) setActiveIdx(options.active);
  }
  function applyEditorState(state: EditorState) {
    scenesNow.current = state.scenes;
    videoNow.current = { avatar: state.avatar, voice: state.voice, speed: state.speed, aspect: state.aspect };
    setScenes(state.scenes);
    setAvatar(state.avatar);
    setVoice(state.voice);
    setSpeed(state.speed);
    setAspect(state.aspect);
  }
  /** Goes back (or forward) one scene change, after asking when the scenes or those settings have changed since, which goes too. */
  function stepHistory(direction: "undo" | "redo") {
    const current = editorNow();
    const step = (direction === "undo" ? undo : redo)(sceneHistory, current, sameEditorState);
    if (!step) return;
    const verb = direction === "undo" ? "Undo" : "Redo";
    if (step.changedSince && !window.confirm(`${verb} “${step.entry.label}”? The changes made since then go too (and come back if you ${direction === "undo" ? "redo" : "undo"} it).`)) return;
    // The first scene the step changes is selected, so what came back (or went again) is in view.
    const changed = step.state.scenes.findIndex((sc, i) => sc !== current.scenes[i]);
    setSceneHistory(step.history);
    applyEditorState(step.state);
    setActiveIdx(changed >= 0 ? changed : Math.min(activeIdx, step.state.scenes.length - 1));
    setImportNote(`${direction === "undo" ? "Undid" : "Redid"}: ${step.entry.label}.`);
    // The button pressed is disabled once there is nothing left to step through; the focus goes to the other one. A
    // control the step takes away (a scene's Merge or Remove, say) leaves the focus on Undo.
    const pressed = direction === "undo" ? undoButton : redoButton;
    const left = direction === "undo" ? step.history.past.length : step.history.future.length;
    const focused = document.activeElement;
    requestAnimationFrame(() => {
      if (!left && focused === pressed.current) (direction === "undo" ? redoButton : undoButton).current?.focus();
      else if (focused instanceof HTMLElement && !focused.isConnected) undoButton.current?.focus();
    });
  }
  const undoButton = useRef<HTMLButtonElement>(null);
  const redoButton = useRef<HTMLButtonElement>(null);
  // Ctrl+Z (⌘Z on a Mac) undoes a scene change and Ctrl+Shift+Z or Ctrl+Y redoes it, outside a field whose own undo
  // takes back typing. The letter is read from the layout (a German keyboard's Y sits where Z is on others), and from
  // the key's place only on a layout without Latin letters.
  const stepHistoryNow = useRef(stepHistory);
  stepHistoryNow.current = stepHistory;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(isApple() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.isContentEditable || t?.closest(`textarea, select, dialog[open], input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="color"])`)) return;
      const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : e.code === "KeyZ" ? "z" : e.code === "KeyY" ? "y" : "";
      if (letter !== "z" && !(letter === "y" && !isApple() && !e.shiftKey)) return;
      e.preventDefault();
      stepHistoryNow.current(letter === "z" && !e.shiftKey ? "undo" : "redo");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  /** Adds a blank scene right after the selected one, on its background (at the end when the last scene is selected). */
  function addScene() {
    if (scenes.length >= MAX_SCENES) return;
    const at = scenes.indexOf(active) + 1;
    changeScenes(`add scene ${at + 1}`, [...scenes.slice(0, at), newScene("", active.background), ...scenes.slice(at)], { active: at });
    // An earlier note would describe some other change, so an add at the end clears it.
    const n = scenes.length;
    setImportNote(at === n ? null : `Added scene ${at + 1} after scene ${at}; ${at + 1 === n ? `scene ${n} is now scene ${n + 1}` : `scenes ${at + 1}–${n} are now ${at + 2}–${n + 1}`}.`);
    // The last scene a video holds disables the button; the focus goes to the new scene's tab rather than the page.
    if (n + 1 >= MAX_SCENES) requestAnimationFrame(() => sceneTabs.current[at]?.focus());
  }
  function removeScene(idx: number) {
    if (scenes.length <= 1) return;
    changeScenes(`remove scene ${idx + 1}`, scenes.filter((_, i) => i !== idx), { active: Math.max(0, idx - 1) });
  }
  // A move to either end disables the button pressed; the focus goes to the other one rather than being lost.
  const moveLeft = useRef<HTMLButtonElement>(null);
  const moveRight = useRef<HTMLButtonElement>(null);
  /** Swaps a scene with its neighbour and keeps it selected. */
  function moveScene(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= scenes.length) return;
    const next = [...scenes];
    [next[idx], next[j]] = [next[j], next[idx]];
    changeScenes(`move scene ${idx + 1} ${dir < 0 ? "earlier" : "later"}`, next, { active: j });
  }
  // A scene tab dragged onto another moves there (the arrow buttons do the same a step at a time). The drag carries
  // the scene itself, so a change to the scenes meanwhile never moves another one, and a type of its own, which text
  // fields do not take, so a tab let go over the script never types into it.
  const dragged = useRef<Scene | null>(null);
  // The dragged scene as shown (faded); the ref is what a drop reads, set as the drag starts.
  const [dragging, setDragging] = useState<Scene | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const sceneTabs = useRef<Array<HTMLButtonElement | null>>([]);
  function endDrag() {
    dragged.current = null;
    setDragging(null);
    setDropTarget(null);
  }
  // A tab the scenes no longer have cannot finish its drag, so the drag is forgotten when they change.
  useEffect(endDrag, [scenes]);
  function dropScene(to: number) {
    const from = dragged.current ? scenes.indexOf(dragged.current) : -1;
    endDrag();
    if (from < 0 || from === to || to < 0 || to >= scenes.length) return;
    changeScenes(`move scene ${from + 1} to ${to + 1}`, moveItem(scenes, from, to), { active: to });
    setImportNote(`Moved scene ${from + 1} to ${to + 1}.`);
    // The browser keeps the focus where it was until the drag has ended, so the tab takes it then (and now, in case the
    // dragged tab is gone and its drag never ends).
    focusAfterDrag.current = to;
    requestAnimationFrame(() => sceneTabs.current[to]?.focus());
  }
  const focusAfterDrag = useRef<number | null>(null);
  /** Gives every other scene the selected scene's background (and its fit), as one change Undo takes back. */
  function applyBackgroundEverywhere() {
    const from = scenes.indexOf(active);
    const bg = active.background;
    const changed = scenes.map((sc, i) => i !== from && !backgroundsMatch(sc.background, bg));
    if (!changed.some(Boolean)) return;
    // A colour cannot fill the frame in the presenter's place, so scenes without the presenter get it back.
    const shown = scenes.flatMap((sc, i) => (changed[i] && bg.type === "color" && sc.hidePresenter ? [i + 1] : []));
    changeScenes(`use scene ${from + 1}'s background on every scene`, scenes.map((sc, i) => (changed[i] ? withBackground(sc, bg) : sc)));
    const named = shown.length === 1 ? `Scene ${shown[0]} shows` : `Scenes ${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]} show`;
    setImportNote(`Every scene now has scene ${from + 1}'s background.${shown.length ? ` ${named} the presenter again, since a color cannot fill the frame in the presenter's place.` : ""}`);
    // The button gives way to a line saying every scene has the background, so the focus goes to Undo, which names it.
    requestAnimationFrame(() => undoButton.current?.focus());
  }
  const importInput = useRef<HTMLInputElement>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  /** Replaces the scenes with a text, Markdown, or Word document's, one per paragraph or section, on the first scene's background. */
  async function importScript(file: File | undefined) {
    if (!file) return;
    const named = /\.(docx|docm|dotx|dotm|doc)$/i.test(file.name) || file.type === DOCX_TYPE;
    if (file.size > (named ? MAX_DOCX_BYTES : MAX_IMPORT_BYTES)) {
      return setImportNote(named ? `${file.name} is larger than ${MAX_DOCX_BYTES / 1_000_000} MB; remove its pictures or save it as plain text.` : `${file.name} is larger than ${MAX_IMPORT_BYTES / 1_000_000} MB; import a plain-text, Markdown, or Word script.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // A Word file is known by its first bytes too (a zip, or an older compound file), so one picked under another
    // name is read as Word or refused with a reason, never imported as binary noise.
    const word = named || (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0);
    let doc: ReturnType<typeof scenesFromText>;
    if (word) {
      // A Word document's headings start scenes (as a Markdown file's do) and its title names the video; its words are taken as written.
      try {
        const read = readDocx(bytes, file.name);
        doc = scenesFromText(read.text, { markdown: false });
        if (read.title) doc = { ...doc, title: read.title };
      } catch (e) {
        return setImportNote(`${(e instanceof Error ? e.message : `${file.name} could not be read`).replace(/\.$/, "")}.`);
      }
    } else {
      // Markdown is read as Markdown (list markers, emphasis, and links are not spoken); any other text as written.
      // A file not in UTF-8 is read in the code page Windows uses for the browser's language.
      doc = scenesFromText(decodeScript(bytes, legacyEncodingFor(navigator.language)), { markdown: /\.(md|markdown)$/i.test(file.name) || file.type === "text/markdown" });
    }
    if (!doc.scenes.length) return setImportNote(`No script found in ${file.name}.`);
    // Anything already set up (a script, a clip, a presenter, a layout, more than one scene) is only replaced once confirmed.
    if (setUpScenes(scenes) && !window.confirm(`Replace the ${scenes.length === 1 ? "current scene" : `current ${scenes.length} scenes`} with ${doc.scenes.length === 1 ? "1 scene" : `${doc.scenes.length} scenes`} from ${file.name}?`)) return;
    const background = scenes[0].background;
    changeScenes(`import ${file.name}`, doc.scenes.map((script) => newScene(script, background)), { active: 0 });
    if (doc.title && (!title.trim() || title === "Untitled video")) setTitle(doc.title);
    setImportNote(`Imported ${doc.scenes.length === 1 ? "1 scene" : `${doc.scenes.length} scenes`} from ${file.name}${doc.truncated ? `; the rest did not fit (a video holds up to ${MAX_SCENES} scenes and ${MAX_SCRIPT_CHARS} characters of script)` : ""}.`);
  }
  /**
   * Puts the brand kit's closing scene at the end, on the kit's background with its text at the bottom of the frame
   * (in place of the one scene of a new video while it is still blank).
   */
  function addClosingScene() {
    const kit = brandData?.brand;
    const closing = kit?.closingScene;
    if (!kit || !closing) return;
    const background: Background = kit.defaultBackground ?? { type: "color", value: kit.primaryColor };
    const last = scenes[scenes.length - 1];
    if (last.script.trim() === closing.script && (last.overlay?.text ?? "") === (closing.text ?? "")) return setImportNote("The last scene is already the brand kit's closing scene.");
    // Only a scene with nothing chosen for it yet (its words, presenter, layout, or a picture or video of its own) is taken over.
    const sameBackground = (b: Background) => b.type === last.background.type && b.value === last.background.value;
    const blank = scenes.length === 1 && !setUpScenes(scenes) && !last.hidePresenter && (sameBackground(background) || sameBackground(DEFAULT_BG));
    if (!blank && scenes.length >= MAX_SCENES) return setImportNote(`A video holds up to ${MAX_SCENES} scenes, so the closing scene does not fit.`);
    // The kit's text in the medium size when it fits across this video's frame, else the small one.
    const overlay: SceneText | undefined = closing.text ? { text: closing.text, position: "bottom", ...(sceneTextFits({ text: closing.text }, aspect) ? {} : { size: "small" as const }) } : undefined;
    const scene = newScene(closing.script, background, overlay ? { overlay } : {});
    const next = blank ? [scene] : [...scenes, scene];
    if (next.map((sc) => sc.script.trim()).join("\n\n").length > MAX_SCRIPT_CHARS) {
      return setImportNote(`The closing scene would take the script past the ${MAX_SCRIPT_CHARS} characters a video holds; shorten it first.`);
    }
    changeScenes("add the closing scene", next, { active: next.length - 1 });
    setImportNote(`Added the brand kit's closing scene as scene ${next.length}.`);
  }
  const [conversationOpen, setConversationOpen] = useState(false);
  const conversationButton = useRef<HTMLButtonElement>(null);
  function closeConversation() {
    setConversationOpen(false);
    requestAnimationFrame(() => conversationButton.current?.focus());
  }
  /** Replaces the scenes with a conversation's turns, each cast with its speaker's presenter and voice, on the first scene's background. */
  function makeConversation(turns: CastTurn[], summary: string) {
    if (setUpScenes(scenes) && !window.confirm(`Replace the ${scenes.length === 1 ? "current scene" : `current ${scenes.length} scenes`} with ${turns.length === 1 ? "1 scene" : `${turns.length} scenes`} from the conversation?`)) return;
    const background = scenes[0].background;
    if (turns.length === 1) {
      // One scene has no presenter or voice of its own to show in the editor, so its speaker's become the video's.
      const a = (turns[0].avatarId && avatarData?.avatars.find((x) => x.id === turns[0].avatarId)) || undefined;
      const v = (turns[0].voiceId && voiceData?.voices.find((x) => x.id === turns[0].voiceId)) || undefined;
      changeScenes("make scenes from the conversation", [newScene(turns[0].script, background)], { active: 0, avatar: a, voice: v });
    } else {
      changeScenes("make scenes from the conversation", turns.map((t) => newScene(t.script, background, { avatarId: t.avatarId || undefined, voiceId: t.voiceId || undefined })), { active: 0 });
    }
    setImportNote(summary);
    closeConversation();
  }
  const slidesInput = useRef<HTMLInputElement>(null);
  const [slidesProgress, setSlidesProgress] = useState<string | null>(null);
  // The scenes as they are now, so an import that took a while can tell whether they were edited meanwhile.
  const scenesNow = useRef(scenes);
  scenesNow.current = scenes;
  const aspectNow = useRef<AspectRatio>("16:9");
  /**
   * Imports a slide deck chosen as a PDF, a PowerPoint (.pptx) file, or both. A PDF gives each scene its page as the
   * background; a .pptx gives each scene its speaker notes as the script (the slide's text where it has none), as
   * HeyGen's PowerPoint import does. With both, the PDF's pages get the matching slides' notes.
   */
  async function importDeck(files: File[]) {
    if (!files.length || slidesProgress) return;
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    const decks = files.filter((f) => !pdfs.includes(f) && (/\.pptx$/i.test(f.name) || f.type === PPTX_TYPE));
    if (pdfs.length > 1 || decks.length > 1 || pdfs.length + decks.length < files.length) {
      return setImportNote("Choose one slide deck: a PDF, a PowerPoint (.pptx) file, or both files of the same deck to show its pages with its speaker notes as the script.");
    }
    const [pdf] = pdfs;
    const [deck] = decks;
    let slides: PptxSlide[] | undefined;
    if (deck) {
      if (deck.size > MAX_PPTX_BYTES) return setImportNote(`${deck.name} is larger than ${MAX_PPTX_BYTES / 1_000_000} MB; save the deck with smaller pictures or as PDF.`);
      setImportNote(null);
      setSlidesProgress(`Reading ${deck.name}…`);
      try {
        slides = readPptx(new Uint8Array(await deck.arrayBuffer()), deck.name);
      } catch (e) {
        setSlidesProgress(null);
        return setImportNote(`${(e instanceof Error ? e.message : `${deck.name} could not be read`).replace(/\.$/, "")}.`);
      }
      if (!pdf) {
        setSlidesProgress(null);
        return importNotes(deck, slides);
      }
    }
    if (pdf) await importSlides(pdf, deck && slides ? { name: deck.name, slides } : undefined);
  }
  /**
   * Replaces the scenes with a PowerPoint deck's slides, each scripted from its speaker notes or, where it has none,
   * its text. Hidden slides are left out, as in the slide show. When there are as many scenes as slides and they show
   * pictures (the same deck imported as PDF first), each scene keeps its background; otherwise the scenes' shared background is used.
   */
  function importNotes(file: File, slides: PptxSlide[]) {
    const shown = slides.filter((sl) => !sl.hidden);
    const kept = shown.slice(0, MAX_SCENES);
    if (!kept.length) return setImportNote(`Every slide in ${file.name} is hidden.`);
    const current = scenesNow.current;
    if (setUpScenes(current) && !window.confirm(`Replace the ${current.length === 1 ? "current scene" : `current ${current.length} scenes`} with ${kept.length === 1 ? "the slide" : `the ${kept.length} slides`} of ${file.name}?`)) return;
    const { scripts, truncated } = slideScripts(kept.map((sl) => sl.notes || sl.text));
    // A scene per slide already showing pictures (the deck's PDF, imported first) keeps them.
    const sameCount = current.length === kept.length && current.some((sc) => sc.background.type !== "color");
    const shared = current.every((sc) => sc.background.type === current[0].background.type && sc.background.value === current[0].background.value) ? current[0].background : DEFAULT_BG;
    changeScenes(`import ${file.name}`, scripts.map((script, i) => newScene(script, sameCount ? current[i].background : shared)), { active: 0 });
    const base = file.name.replace(/\.pptx$/i, "").slice(0, 60) || "Slides";
    setTitle((t) => (!t.trim() || t === "Untitled video" ? base : t));
    const withNotes = kept.filter((sl) => sl.notes).length;
    const fromText = kept.filter((sl) => !sl.notes && sl.text.trim()).length;
    const blank = scripts.filter((sc) => !sc.trim()).length;
    const hidden = slides.length - shown.length;
    const over = shown.length - kept.length;
    setImportNote(
      [
        `Imported ${kept.length === 1 ? "1 slide" : `${kept.length} slides`} of ${file.name} as scenes, each scripted from its ${withNotes ? "speaker notes" : "slide text, since the deck has no speaker notes"}`,
        withNotes && fromText ? `; ${fromText === 1 ? "1 slide has no notes, so its text is" : `${fromText} slides have no notes, so their text is`} the script` : "",
        hidden ? `; ${hidden === 1 ? "1 hidden slide was" : `${hidden} hidden slides were`} left out` : "",
        over ? `; a video holds ${MAX_SCENES} scenes, so the last ${over === 1 ? "slide was" : `${over} slides were`} left out` : "",
        truncated ? `; the scripts were shortened to fit ${MAX_SCRIPT_CHARS} characters` : "",
        blank ? `; ${blank === 1 ? "1 slide has" : `${blank} slides have`} no notes or text, so write what the presenter says there` : "",
        sameCount ? "; each scene kept its background" : ". To show each slide behind the presenter, choose the deck saved as PDF together with the .pptx",
        ".",
      ].join(""),
    );
  }
  /**
   * Replaces the scenes with a slide deck saved as PDF, like HeyGen's PDF import: each page (up to the scene limit)
   * becomes a scene with the page as its uploaded background image and the page's text as a first draft of the
   * script, and the format follows the first page's shape. Pages are drawn and uploaded one at a time. With the
   * deck's PowerPoint slides, each page's script is its slide's speaker notes instead, where it has any.
   */
  async function importSlides(file: File, deck?: { name: string; slides: PptxSlide[] }) {
    if (file.size > MAX_PDF_BYTES) {
      setSlidesProgress(null);
      return setImportNote(`${file.name} is larger than ${MAX_PDF_BYTES / 1_000_000} MB; save the deck as a smaller PDF.`);
    }
    // Snapshots taken once the user has agreed, to tell whether the scenes or the format were changed during the import.
    let before = scenesNow.current;
    let aspectBefore = aspectNow.current;
    setImportNote(null);
    setSlidesProgress(`Reading ${file.name}…`);
    const base = file.name.replace(/\.pdf$/i, "").slice(0, 60) || "Slides";
    const made: Backdrop[] = [];
    const texts: string[] = [];
    try {
      const { count, total, aspect: deckAspect } = await renderPdf(file, {
        // The image allowance is read fresh, not from a list that may be stale or still loading.
        // The allowance is checked before asking to replace anything, so the question is never followed by a refusal.
        onStart: async ({ count }) => {
          const { backdrops } = await api<{ backdrops: Backdrop[] }>("/api/backdrops");
          const room = MAX_BACKDROPS - backdrops.length;
          if (count > room) {
            throw new Error(`${file.name} needs ${count} background images, and ${room <= 0 ? "none are" : `only ${room} ${room === 1 ? "is" : "are"}`} left of the ${MAX_BACKDROPS} an account keeps; delete some under Background → Your images`);
          }
          const current = scenesNow.current;
          if (setUpScenes(current) && !window.confirm(`Replace the ${current.length === 1 ? "current scene" : `current ${current.length} scenes`} with ${count === 1 ? "the page" : `the ${count} pages`} of ${file.name}?`)) {
            throw new ImportCancelled();
          }
          before = scenesNow.current;
          aspectBefore = aspectNow.current;
        },
        onPage: async (page, i, of) => {
          setSlidesProgress(`Importing page ${i + 1} of ${of}…`);
          const { backdrop } = await api<{ backdrop: Backdrop }>("/api/backdrops", { method: "POST", body: JSON.stringify({ name: `${base} – page ${i + 1}`, image: page.image }) });
          made.push(backdrop);
          texts.push(page.text);
        },
      });
      if (!count) return setImportNote(`${file.name} has no pages.`);
      // Scenes edited while the deck was importing are not replaced without asking again.
      if (scenesNow.current !== before && setUpScenes(scenesNow.current) && !window.confirm(`The scenes changed while ${file.name} was importing. Replace them with its pages anyway?`)) {
        return setImportNote(`The ${count} pages of ${file.name} are under Background → Your images; the scenes were left as they are.`);
      }
      const paired = deck ? slidesForPages(deck.slides, total) : undefined;
      const notes = paired ? texts.map((_, i) => paired.slides[i]?.notes ?? "") : [];
      const { scripts, truncated } = slideScripts(texts.map((text, i) => notes[i] || text));
      // The new images join the list in the same update as the scenes, so the check for scenes naming an image that
      // is gone never sees one without the other.
      setBackdropData((d) => ({ backdrops: [...[...made].reverse(), ...(d?.backdrops ?? []).filter((b) => !made.some((m) => m.id === b.id))] }));
      // A format picked while the deck was importing is the user's choice and stays.
      changeScenes(`import ${file.name}`, made.map((b, i) => newScene(scripts[i], { type: "image", value: backdropPath(b.id) })), { active: 0, aspect: aspectNow.current === aspectBefore ? deckAspect : undefined });
      setTitle((t) => (!t.trim() || t === "Untitled video" ? base : t));
      const blank = scripts.filter((sc) => !sc.trim()).length;
      const fromText = deck ? texts.filter((text, i) => !notes[i] && text.trim()).length : 0;
      setImportNote(
        [
          deck
            ? `Imported ${count === 1 ? "1 page" : `${count} pages`} of ${file.name} as scenes, each page behind the presenter and the speaker notes from ${deck.name} as the script to edit`
            : `Imported ${count === 1 ? "1 page" : `${count} pages`} of ${file.name} as scenes, each page behind the presenter and its text as the script to edit`,
          paired && !paired.matches ? `; ${deck!.name} has ${paired.slides.length === 1 ? "1 slide" : `${paired.slides.length} slides`} shown and ${file.name} ${total === 1 ? "1 page" : `${total} pages`}, so the notes were matched in order and may be off; check each scene's script` : "",
          fromText ? `; ${fromText === 1 ? "1 page has no notes, so its text is" : `${fromText} pages have no notes, so their text is`} the script` : "",
          total > count ? `; a video holds ${MAX_SCENES} scenes, so the last ${total - count} of ${total} pages were left out` : "",
          truncated ? `; the ${deck ? "scripts were" : "page text was"} shortened to fit ${MAX_SCRIPT_CHARS} characters of script` : "",
          blank ? `; ${blank === 1 ? "1 page has" : `${blank} pages have`} no ${deck ? "notes or text" : "text"}, so write what the presenter says there` : "",
          ".",
        ].join(""),
      );
    } catch (e) {
      if (e instanceof ImportCancelled) return;
      const reason = (e instanceof Error ? e.message : "The slides could not be imported").replace(/\.$/, "");
      setImportNote(made.length ? `${reason}. The ${made.length} pages uploaded before that are under Background → Your images.` : `${reason}.`);
    } finally {
      // The list is read again rather than patched, so it is right even if it had not loaded when the import began.
      if (made.length) {
        await api<{ backdrops: Backdrop[] }>("/api/backdrops")
          .then((fresh) => setBackdropData(fresh))
          .catch(() => setBackdropData((d) => (d ? { backdrops: [...[...made].reverse(), ...d.backdrops.filter((b) => !made.some((m) => m.id === b.id))] } : d)));
      }
      setSlidesProgress(null);
    }
  }
  /**
   * Cuts the selected scene in two at the cursor: the words after it become the next scene, with the same presenter,
   * voice, background, layout, and pace (the on-screen text stays with the first), and the cursor goes to its start.
   */
  function splitActiveScene() {
    const at = scriptRef.current?.selectionStart ?? -1;
    if (scenes.length >= MAX_SCENES) return setImportNote(`A video holds up to ${MAX_SCENES} scenes, so this one cannot be split.`);
    const parts = splitScene(active, at);
    if (!parts) {
      return setImportNote(
        `Put the cursor between two words where the scene should be split, with words on both sides; a side of only pauses must last ${MIN_SILENT_SEC} to ${MAX_SILENT_SEC} seconds.`,
      );
    }
    const idx = activeIdx;
    const next = [...scenes.slice(0, idx), ...parts, ...scenes.slice(idx + 1)];
    // The cut becomes a blank line between scenes, so a script at the limit could go over it.
    if (next.map((sc) => sc.script.trim()).join("\n\n").length > MAX_SCRIPT_CHARS) {
      return setImportNote(`Splitting here would take the script past the ${MAX_SCRIPT_CHARS} characters a video holds; shorten it first.`);
    }
    changeScenes(`split scene ${idx + 1}`, next, { active: idx + 1 });
    setImportNote(`Split scene ${idx + 1}: the words after the cursor are scene ${idx + 2} now.`);
    requestAnimationFrame(() => {
      scriptRef.current?.focus();
      scriptRef.current?.setSelectionRange(0, 0);
    });
  }
  /** Joins the selected scene and the next into one, after asking when the next one renders with settings that would go. */
  function mergeWithNext() {
    const idx = activeIdx;
    if (idx >= scenes.length - 1) return;
    const merged = mergeScenes(scenes[idx], scenes[idx + 1]);
    if (!merged) return setImportNote(`Scenes ${idx + 1} and ${idx + 2} together would be a silent scene longer than ${MAX_SILENT_SEC} seconds, so they stay apart.`);
    const { lost } = merged;
    const list = lost.length > 1 ? `${lost.slice(0, -1).join(", ")} and ${lost[lost.length - 1]}` : lost[0];
    const ask = `Merge scene ${idx + 2} into scene ${idx + 1}? Scene ${idx + 2}'s words join scene ${idx + 1}, which keeps its ${list}; scene ${idx + 2}'s ${lost.length > 1 ? "are" : "is"} dropped.`;
    if (lost.length && !window.confirm(ask)) return;
    const next = [...scenes.slice(0, idx), merged.scene, ...scenes.slice(idx + 2)];
    // A lone scene shows no presenter or voice of its own in the editor, so those become the video's (as its pace does).
    let lone: { avatar?: Avatar; voice?: Voice } = {};
    if (next.length === 1) {
      lone = {
        avatar: (merged.scene.avatarId && avatarData?.avatars.find((x) => x.id === merged.scene.avatarId)) || undefined,
        voice: (merged.scene.voiceId && voiceData?.voices.find((x) => x.id === merged.scene.voiceId)) || undefined,
      };
      const { avatarId: _a, voiceId: _v, ...rest } = merged.scene;
      next[0] = rest;
    }
    changeScenes(`merge scene ${idx + 2} into scene ${idx + 1}`, next, lone);
    setImportNote(`Merged scene ${idx + 2} into scene ${idx + 1}.`);
    // When the merge leaves no scene after this one that can be merged, the button goes, so the focus goes to the merged words.
    if (!next[idx + 1] || next[idx + 1].audioId) requestAnimationFrame(() => scriptRef.current?.focus());
  }
  /** Inserts a copy right after the scene (script, background, and presenter included) and selects it. */
  function duplicateScene(idx: number) {
    if (scenes.length >= MAX_SCENES) return;
    changeScenes(`duplicate scene ${idx + 1}`, [...scenes.slice(0, idx + 1), { ...scenes[idx] }, ...scenes.slice(idx + 1)], { active: idx + 1 });
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
  // Whether any scene shows a photo avatar, which is all the photo avatar motion settings apply to.
  const photoInUse = scenes.some((sc) => {
    if (sc.hidePresenter) return false;
    const a = (sc.avatarId && avatarData?.avatars.find((x) => x.id === sc.avatarId)) || avatar;
    return !!a && isPhotoAvatar(a);
  });
  // The voices an accent can be chosen for: each that speaks a scene (its own, else the video's; not a recorded clip
  // or a silent scene) and offers accents of its language. The renderer gives each scene the accent only when its
  // voice takes it, so every such voice's accents are offered, and one that no speaking voice takes is not sent.
  const accentVoices = [
    ...new Set(scenes.filter((sc) => !sc.audioId && !silentSeconds(sc.script)).map((sc) => (sc.voiceId && voiceData?.voices.find((v) => v.id === sc.voiceId)) || voice)),
  ].filter((v): v is Voice => !!v?.accents && accentsFor(v.language).length > 0);
  const accentOptions = VOICE_ACCENTS.filter((a) => accentVoices.some((v) => accentsFor(v.language).includes(a)));
  // What the scene's presenter will get: a photo avatar has no close-up, so it is previewed and listed in full.
  const framing: PresenterFraming = framingFor(layout.framing, sceneAvatar ?? undefined);
  const photoPresenter = !!sceneAvatar && isPhotoAvatar(sceneAvatar);
  // The layout as it renders, for the panel's summary and its Reset button.
  const shownLayout: SceneLayout = { ...layout, framing };
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
        // Everything else the scene holds is kept: only the missing presenter, voice, or clip goes.
        return newScene(sc.script, sc.background, { ...sc, avatarId: dropAvatar ? undefined : sc.avatarId, voiceId: dropVoice ? undefined : sc.voiceId, audioId: dropAudio ? undefined : sc.audioId });
      });
      return changed ? next : prev;
    });
  }, [avatarData, voiceData, clipData, clipsError, scenes]);
  // Likewise an uploaded background image that is gone (deleted here or in another tab, or never this account's: a
  // draft from another workspace, a template, a copied video, the Video Agent): the scene gets a plain background,
  // with a note, instead of a blank stage and a render that would be refused. A list that failed to load decides nothing.
  useEffect(() => {
    if (!backdropData) return;
    const known = new Set(backdropData.backdrops.map((b) => b.id));
    setScenes((prev) => {
      let changed = false;
      const next = prev.map((sc) => {
        const id = backdropIdOf(sc.background);
        if (!id || known.has(id)) return sc;
        changed = true;
        return withBackground(sc, DEFAULT_BG);
      });
      if (changed) setImportNote("A background image some scenes used has been deleted, so they have a plain background now.");
      return changed ? next : prev;
    });
  }, [backdropData, scenes]);
  const [aspect, setAspect] = useState<AspectRatio>("16:9");
  aspectNow.current = aspect;
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [captions, setCaptions] = useState(false);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(DEFAULT_CAPTION_STYLE);
  const isDefaultCaptionStyle = isDefaultCaptionStyleFn(captionStyle);
  const [speed, setSpeed] = useState(1);
  videoNow.current = { avatar, voice, speed, aspect };
  // A lone scene's pace is the video's, which the slider sets: one left after a removal, or loaded from a copy or a
  // template, hands its speed to the slider (its own picker shows only with several scenes).
  const loneSpeed = scenes.length === 1 ? scenes[0].speed : undefined;
  useEffect(() => {
    if (!loneSpeed) return;
    setSpeed(loneSpeed);
    setScenes((prev) => (prev.length === 1 ? [{ ...prev[0], speed: undefined }] : prev));
  }, [loneSpeed]);
  const [pitch, setPitch] = useState(0);
  const [emotion, setEmotion] = useState<VoiceEmotion | "">("");
  const [expressiveness, setExpressiveness] = useState<PhotoExpressiveness>("low");
  const [motionPrompt, setMotionPrompt] = useState("");
  // Whether any scene's presenter would render on Avatar V, the only scenes the engine choice reaches.
  const avatarVInUse = scenes.some((sc) => {
    if (sc.hidePresenter) return false;
    const a = (sc.avatarId && avatarData?.avatars.find((x) => x.id === sc.avatarId)) || avatar;
    return !!a && rendersOnAvatarV(a, { ...(expressiveness !== "low" ? { expressiveness } : {}), motionPrompt: motionPrompt.trim() });
  });
  const [accent, setAccent] = useState<VoiceAccent | "">("");
  const [avatarEngine, setAvatarEngine] = useState<AvatarEngine>("avatar_iv");
  // More natural blinking is an Avatar V setting: kept while another engine is chosen, sent only with Avatar V.
  const [moreBlinking, setMoreBlinking] = useState(false);
  const [transparent, setTransparent] = useState(false);
  // A transparent background is HeyGen's single-presenter WebM: one scene that shows the presenter.
  const canTransparent = scenes.length === 1 && !scenes[0].hidePresenter;
  const sentTransparent = transparent && canTransparent;
  // Whether gestures reach a video avatar: one whose look supports Avatar V takes them there, and not on Avatar IV.
  const videoLookOnV = scenes.some((sc) => {
    if (sc.hidePresenter) return false;
    const a = (sc.avatarId && avatarData?.avatars.find((x) => x.id === sc.avatarId)) || avatar;
    return !!a && !isPhotoAvatar(a) && !!a.avatarV;
  });
  const gesturesOnV = avatarEngine === "avatar_v" && videoLookOnV;
  const sentAccent = accent && accentVoices.some((v) => voiceTakesAccent(v, accent)) ? accent : undefined;
  const accentTakers = accent ? accentVoices.filter((v) => voiceTakesAccent(v, accent)) : accentVoices;
  /** Expressiveness applies to photo avatars, gestures also to video avatars on Avatar V; the defaults are sent as none. */
  const motion = { ...(expressiveness !== "low" ? { expressiveness } : {}), ...(motionPrompt.trim() ? { motionPrompt: motionPrompt.trim() } : {}) };
  const [tab, setTab] = useState<Tab>("avatar");
  const [writerOpen, setWriterOpen] = useState(params.get("writer") === "1");
  const [assistOpen, setAssistOpen] = useState(false);
  const writerButton = useRef<HTMLButtonElement>(null);
  // Find and replace across every scene's script.
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [findCase, setFindCase] = useState(false);
  const [findWhole, setFindWhole] = useState(false);
  // The last Replace all: what it said and the scripts before and after, so it can be undone while nothing else changed.
  const [findDone, setFindDone] = useState<{ note: string; before: string[]; after: string[] } | null>(null);
  /** Why the last Replace all changed nothing (the result would not fit), while the search and the scripts are unchanged. */
  const [findIssue, setFindIssue] = useState<{ note: string; scripts: string } | null>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const improveButton = useRef<HTMLButtonElement>(null);
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistTone, setAssistTone] = useState<(typeof TONES)[number]>("professional");
  const [assistLanguage, setAssistLanguage] = useState("Spanish");

  /**
   * The script a rewrite (the AI writer or Improve) replaced, while the scene still holds what the rewrite wrote. The
   * scene is the one object the rewrite wrote: scenes are never changed in place, so it is the same object until that
   * scene is edited, wherever it has moved.
   */
  const [rewriteUndo, setRewriteUndo] = useState<{ scene: Scene; before: string; note: string } | null>(null);
  /** Why the last rewrite was not applied, shown beside the script it was for. */
  const [rewriteErr, setRewriteErr] = useState<string | null>(null);
  /**
   * Replaces a scene's script with a rewrite, keeping what it held so the rewrite can be taken back. The rewrite goes to
   * the scene it was asked for (`target`, as it was then), wherever that scene has moved; nothing is written when that
   * scene has since been edited or removed, so a rewrite never lands on other words or another scene, and its Undo never
   * wipes that scene's own script.
   */
  function applyRewrite(target: Scene, after: string, note: string): boolean {
    if (!scenesNow.current.includes(target)) {
      setRewriteErr("The scene changed while it was being rewritten, so the rewrite was not applied. Try again.");
      return false;
    }
    const updated: Scene = { ...target, script: after };
    setScenes((prev) => prev.map((sc) => (sc === target ? updated : sc)));
    setRewriteErr(null);
    setRewriteUndo(target.script.trim() && target.script !== after ? { scene: updated, before: target.script, note } : null);
    // Still the scene being worked on (moved, perhaps): it stays selected and its script takes the focus back from the
    // panel. Another scene chosen meanwhile stays chosen, so what is being typed there keeps going where it was going.
    if (scenesNow.current[activeIdxNow.current] === target) {
      setActiveIdx(scenesNow.current.indexOf(target));
      requestAnimationFrame(() => scriptRef.current?.focus());
    }
    return true;
  }
  async function revise(action: "shorten" | "expand" | "tone" | "translate" | "polish") {
    if (!active.script.trim()) return;
    // The scene asked about, even if another is chosen or it is moved while the answer comes.
    const target = active;
    const before = active.script;
    setAssistBusy(true);
    setRewriteErr(null);
    try {
      const { script: out } = await api<{ script: string }>("/api/script", {
        method: "POST",
        body: JSON.stringify({ action, script: before, tone: action === "tone" ? assistTone : undefined, language: action === "translate" ? assistLanguage : undefined }),
      });
      if (applyRewrite(target, out, action === "translate" ? `Translated to ${assistLanguage}.` : "Rewritten.")) setAssistOpen(false);
    } catch (e) {
      setRewriteErr(e instanceof Error ? e.message : "Could not revise the script");
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
  // The draft belongs to the space being worked in, so nothing is restored or saved until that is known.
  const { data: spaces, error: spacesError } = useApi<{ personalId: string; activeId: string }>("/api/workspaces");
  // Unknown (the list failed to load), no draft is restored or saved: guessing Personal would show its draft in a
  // workspace and spoil it there. A template, a copy, or a plan still opens.
  const draftKey = draftKeyFor(spaces);
  const spacesKnown = !!spaces || !!spacesError;
  const templateId = params.get("template");
  const fromId = params.get("from");
  // A video spoken by one of the account's audio clips (?clip=, from a recording kept in the voice changer).
  const clipStart = !fromId && !templateId ? params.get("clip") : null;
  // A video set against one of the account's pictures (?picture=, from the Assets page).
  const pictureStart = !fromId && !templateId && !clipStart ? params.get("picture") : null;
  // A copy of a video, a template, or a clip keeps its own draft, so editing one never overwrites the unsent draft of a
  // plain visit, and a reload brings back the edits rather than the original.
  const draftSource = fromId ? `from:${fromId}` : templateId ? `template:${templateId}` : clipStart ? `clip:${clipStart}` : pictureStart ? `picture:${pictureStart}` : "";
  const editKey = draftKey && (draftSource ? `${draftKey}:${draftSource}` : draftKey);
  // A Video Agent plan to review (?plan=agent), read once: a refresh comes back to the autosaved draft of it.
  const agentPlan = useRef<AgentDraft | null | undefined>(undefined);
  const [fromAgent, setFromAgent] = useState(false);

  // Whether the requested copy, template, or clip had kept edits when the editor opened (autosave writes more later).
  const hadEdits = useRef(false);
  // Restore an unsent draft: a plain visit's, or the edits of the copy or template requested.
  useEffect(() => {
    if (hydrated.current || !spacesKnown) return;
    hydrated.current = true;
    hadEdits.current = !!editKey && !!draftSource && !!readDraft(editKey);
    if (!draftSource && params.get("plan") === "agent") {
      if (agentPlan.current === undefined) agentPlan.current = takeAgentDraft();
      const p = agentPlan.current;
      if (p) {
        setTitle(p.title);
        setScenes(p.scenes.map((sc) => newScene(sc.script, sc.background, { layout: restoredLayout(sc.layout) })));
        // What the editor starts from (a plan, a draft, a template, a copy, a clip, a picture) is not a change to undo,
        // and nothing done before it arrived can be undone over it.
        setSceneHistory(emptyHistory());
        setActiveIdx(0);
        setAspect(p.aspect);
        setResolution(p.resolution);
        setCaptions(p.captions);
        setPrefill({ avatarId: p.avatarId, voiceId: p.voiceId });
        setFromAgent(true);
        return;
      }
    }
    // Nothing to restore without the space's key, or over words typed while the space was being looked up.
    if (!editKey || scenesNow.current.some(hasContent)) return;
    const d = readDraft(editKey);
    if (!d) return;
    setTitle(d.title);
    setScenes(d.scenes.map((sc) => newScene(sc.script, sc.background, { ...sc, layout: restoredLayout(sc.layout) })));
    setSceneHistory(emptyHistory());
    setActiveIdx(0);
    setAspect(d.aspect);
    setResolution(d.resolution ?? "1080p");
    setCaptions(d.captions);
    // A draft is the browser's own copy, saved by whatever build ran then: keep only a look and typeface this build offers.
    setCaptionStyle(d.captionStyle ? restoredCaptionStyle(d.captionStyle) : DEFAULT_CAPTION_STYLE);
    setSpeed(d.speed);
    setPitch(d.pitch ?? 0);
    // A draft is the browser's own copy, so a value no longer offered is dropped rather than sent.
    setEmotion(asEmotion(d.emotion));
    setExpressiveness(asExpressiveness(d.expressiveness));
    setMotionPrompt(asMotionPrompt(d.motionPrompt));
    setAccent(asAccent(d.accent));
    setAvatarEngine(asAvatarEngine(d.avatarEngine));
    setMoreBlinking(d.moreBlinking === true);
    setTransparent(d.transparent === true);
    setPrefill({ avatarId: d.avatarId, voiceId: d.voiceId });
    setDraftRestored(d.savedAt);
  }, [draftSource, params, editKey, spacesKnown]);

  // Set once a render has started from this draft: the draft is cleared then, and no autosave may write it back while
  // the page is on its way to the video (a timer still pending, or one re-armed by data arriving meanwhile).
  const sent = useRef(false);
  // The title a clip or picture start gave the video, so a start left untouched leaves no draft behind.
  const startTitle = useRef<string | null>(null);
  // Autosave the editor state (debounced) so a refresh never loses work.
  useEffect(() => {
    if (!hydrated.current || !editKey || sent.current) return;
    // A clip or picture start names the video after it; that alone is not an edit worth a draft.
    const empty = !scenes.some(hasContent) && (title === "Untitled video" || title === startTitle.current);
    const t = setTimeout(() => {
      if (sent.current) return;
      writeDraft(editKey, empty ? null : { title, scenes, aspect, resolution, captions, ...(isDefaultCaptionStyle ? {} : { captionStyle }), speed, ...(pitch ? { pitch } : {}), ...(emotion ? { emotion } : {}), ...(expressiveness !== "low" ? { expressiveness } : {}), ...(motionPrompt ? { motionPrompt } : {}), ...(accent ? { accent } : {}), ...(avatarEngine !== "avatar_iv" ? { avatarEngine } : {}), ...(moreBlinking ? { moreBlinking } : {}), ...(transparent ? { transparent } : {}), avatarId: avatar?.id, voiceId: voice?.id, savedAt: new Date().toISOString() });
    }, 400);
    return () => clearTimeout(t);
  }, [title, scenes, aspect, resolution, captions, captionStyle, isDefaultCaptionStyle, speed, pitch, emotion, expressiveness, motionPrompt, accent, avatarEngine, moreBlinking, transparent, avatar, voice, editKey]);

  function discardDraft() {
    if (editKey) writeDraft(editKey, null);
    // A copy or template starts again from its original.
    if (draftSource) {
      window.location.reload();
      return;
    }
    setTitle("Untitled video");
    setScenes([newScene()]);
    setSceneHistory(emptyHistory());
    setActiveIdx(0);
    setAspect("16:9");
    setResolution("1080p");
    setCaptions(false);
    setSpeed(1);
    setPitch(0);
    setEmotion("");
    setExpressiveness("low");
    setMotionPrompt("");
    setAccent("");
    setAvatarEngine("avatar_iv");
    setMoreBlinking(false);
    setTransparent(false);
    setCaptionStyle(DEFAULT_CAPTION_STYLE);
    // Back to a fresh editor's presenter and voice: the first ones, then the brand kit's defaults on top.
    setAvatar(null);
    setVoice(null);
    // A draft restored before the lists loaded still has its presenter waiting to be applied; drop it.
    setPrefill(null);
    brandApplied.current = false;
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
    // A Video Agent plan already carries the kit's presenter, voice, background, captions, and quality.
    if (!b || fromId || draftRestored || fromAgent || templateId?.startsWith("tpl_")) return;
    if (b.captionsByDefault != null) setCaptions(b.captionsByDefault);
    if (b.defaultAvatarId || b.defaultVoiceId) setPrefill({ avatarId: b.defaultAvatarId, voiceId: b.defaultVoiceId });
    if (b.defaultResolution) setResolution(b.defaultResolution);
    if (templateId) return;
    if (b.defaultAspect) setAspect(b.defaultAspect);
    // A scene the clip start filled with the clip's words is as fresh as an empty one; the picture a video was started
    // against is kept.
    const keep = (sc: Scene) => (!!sc.script.trim() && !(clipStart && sc.audioId === clipStart)) || (!!pictureStart && backdropIdOf(sc.background) === pictureStart);
    setScenes((prev) => prev.map((sc) => (keep(sc) ? sc : withBackground(sc, b.defaultBackground ?? { type: "color", value: b.primaryColor }))));
  }, [brandData, fromId, templateId, draftRestored, fromAgent, clipStart, pictureStart]);

  // Pre-fill from a template (?template=) or an existing video (?from=), unless its edits were kept from before.
  const keptEdits = () => !!editKey && !!draftSource && !!readDraft(editKey);
  useEffect(() => {
    if (!spacesKnown || keptEdits()) return;
    const t = findTemplate(templateId);
    if (t) {
      setTitle(t.title);
      setScenes([newScene(t.script)]);
      setSceneHistory(emptyHistory());
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
        setSceneHistory(emptyHistory());
        setActiveIdx(0);
        setAspect(template.aspect);
        setResolution(template.resolution ?? "1080p");
        setCaptions(template.captions);
        setCaptionStyle(template.captionStyle ?? DEFAULT_CAPTION_STYLE);
        setSpeed(template.speed);
        setPitch(template.pitch ?? 0);
        setEmotion(template.emotion ?? "");
        setExpressiveness(asExpressiveness(template.expressiveness));
        setMotionPrompt(asMotionPrompt(template.motionPrompt));
        setAccent(asAccent(template.accent));
        setAvatarEngine(asAvatarEngine(template.avatarEngine));
        setMoreBlinking(template.moreBlinking === true);
        setTransparent(template.transparent === true);
        setPrefill({ avatarId: template.avatarId, voiceId: template.voiceId });
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not load the template"));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once the space (and so the draft key) is known
  }, [templateId, spacesKnown]);
  useEffect(() => {
    if (!fromId || !spacesKnown || keptEdits()) return;
    api<{ video: Video }>(`/api/videos/${fromId}`)
      .then(({ video }) => {
        // A cinematic shot has no scenes to copy, and a HeyGen template's are not here; each has its own form to make another.
        if (video.cinematic) {
          setErr(`"${video.title}" is a cinematic shot made from a description; make it again from the Cinematic page.`);
          return;
        }
        if (video.directed) {
          setErr(`"${video.title}" was directed by HeyGen's Video Agent from a brief; ask the agent again from the Video Agent page.`);
          return;
        }
        if (video.studioTemplate) {
          setErr(`"${video.title}" was made from the HeyGen template "${video.studioTemplate.name}"; use the template again from the Templates page to make another.`);
          return;
        }
        setTitle(`${video.title} (copy)`);
        setScenes(video.scenes?.length ? video.scenes.map((sc) => newScene(sc.script, sc.background, sc)) : [newScene(video.script, video.background)]);
        setSceneHistory(emptyHistory());
        setActiveIdx(0);
        setAspect(video.aspect);
        setResolution(video.resolution ?? "1080p");
        setCaptions(video.captions);
        setCaptionStyle(video.captionStyle ?? DEFAULT_CAPTION_STYLE);
        setSpeed(video.speed);
        setPitch(video.pitch ?? 0);
        setEmotion(video.emotion ?? "");
        setExpressiveness(asExpressiveness(video.expressiveness));
        setMotionPrompt(asMotionPrompt(video.motionPrompt));
        setAccent(asAccent(video.accent));
        setAvatarEngine(asAvatarEngine(video.avatarEngine));
        setMoreBlinking(video.moreBlinking === true);
        setTransparent(video.transparent === true);
        setPrefill({ avatarId: video.avatarId, voiceId: video.voiceId });
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not load the original video"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once the space (and so the draft key) is known
  }, [fromId, spacesKnown]);

  // Start from a clip (?clip=): one scene lip-syncing to it, its words as the script when they are known. Once the
  // clips are loaded; one that is gone says so and leaves an empty video.
  const clipApplied = useRef(false);
  useEffect(() => {
    if (!clipStart || clipApplied.current || !hydrated.current || (!clipData && !clipsError)) return;
    clipApplied.current = true;
    // Kept edits came back with the draft; words typed while the clips were loading are not replaced either.
    if (hadEdits.current || scenesNow.current.some(hasContent)) return;
    const clip = clipData?.clips.find((c) => c.id === clipStart);
    if (!clip) {
      setErr(clipsError ? "Your audio clips could not be loaded, so the video cannot start from one; reload to try again." : "That audio clip is no longer available; choose another in a scene's Audio tab.");
      return;
    }
    setTitle((t) => (t === "Untitled video" ? clip.name : t));
    startTitle.current = clip.name;
    setScenes((prev) => [newScene(clip.transcript ?? "", prev[0]?.background, { audioId: clip.id })]);
    setSceneHistory(emptyHistory());
    setActiveIdx(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once the space (and so the draft key) and the clips are known
  }, [clipStart, spacesKnown, clipData, clipsError]);

  // Start against a picture (?picture=): the first scene shows it, once the pictures are loaded; one that is gone says
  // so and leaves an empty video.
  const pictureApplied = useRef(false);
  useEffect(() => {
    if (!pictureStart || pictureApplied.current || !hydrated.current || (!backdropData && !backdropError)) return;
    pictureApplied.current = true;
    if (hadEdits.current || scenesNow.current.some(hasContent)) return;
    const picture = backdropData?.backdrops.find((b) => b.id === pictureStart);
    if (!picture) {
      setErr(backdropError ? "Your pictures could not be loaded, so the video cannot start from one; reload to try again." : "That picture is no longer available; choose another in a scene's Background tab.");
      return;
    }
    setTitle((t) => (t === "Untitled video" ? picture.name : t));
    startTitle.current = picture.name;
    setScenes((prev) => [withBackground(prev[0] ?? newScene(), { type: "image", value: backdropPath(picture.id) })]);
    setSceneHistory(emptyHistory());
    setActiveIdx(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once the space (and so the draft key) and the pictures are known
  }, [pictureStart, spacesKnown, backdropData, backdropError]);

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
  // A voice is previewed on the first scene that says something (not a silent one), a pause cut in half dropped.
  const previewText = (scenes.find((sc) => !sc.audioId && stripPauses(sc.script).trim())?.script ?? "").trim().slice(0, 200).replace(/\[[^\]]*$/, "").trim();
  /** A typed scene lasts as long as its words take at its speed (its own, else the video's); an audio scene as long as its clip. */
  const sceneSeconds = (sc: Scene) => {
    const clip = sc.audioId ? clips.find((c) => c.id === sc.audioId) : undefined;
    return clip ? Math.round(clip.durationSec) : estimateSeconds(sc.script, sc.speed ?? speed);
  };
  // Typed scenes at one speed are estimated together, as before audio scenes existed, so short scenes are not each rounded up.
  const typedBySpeed = new Map<number, string[]>();
  for (const sc of scenes) if (!sc.audioId) typedBySpeed.set(sc.speed ?? speed, [...(typedBySpeed.get(sc.speed ?? speed) ?? []), sc.script]);
  const seconds =
    scenes.reduce((sum, sc) => sum + (sc.audioId ? sceneSeconds(sc) : 0), 0) +
    [...typedBySpeed].reduce((sum, [pace, scripts]) => sum + estimateSeconds(scripts.join("\n\n"), pace), 0);
  // A scene of only pauses is a silent one (the presenter holds without a word), but the video as a whole needs words.
  const allScenesFilled = scenes.every((sc) => sc.script.trim().length > 0) && scenes.some((sc) => sc.audioId || !silentSeconds(sc.script));
  const silentIssue = scenes.map((sc) => (sc.audioId ? null : silentProblem(sc.script))).find(Boolean) ?? null;
  // The server takes up to 5000 characters of script across all scenes (joined by a blank line).
  const scriptChars = scenes.map((sc) => sc.script.trim()).join("\n\n").length;
  const scriptTooLong = scriptChars > MAX_SCRIPT_CHARS;
  // A template's {placeholders} left in a script would be read out as they are.
  // On-screen text is drawn as it is, so a placeholder there is checked too.
  const unfilled = [...new Set(scenes.flatMap((sc) => [sc.script, sc.overlay?.text ?? ""].flatMap((t) => t.match(/\{[\p{L}_][\p{L}\p{N}_ -]{0,39}\}/gu) ?? [])))];
  const canEdit = useCanEdit();
  const canGenerate = canEdit !== false && !!avatar && !!voice && allScenesFilled && !silentIssue && !scriptTooLong && title.trim().length > 0 && !submitting;

  async function generate() {
    if (!avatar || !voice) return;
    setSubmitting(true);
    setErr(null);
    try {
      const { video } = await api<{ video: Video }>("/api/videos", {
        method: "POST",
        body: JSON.stringify({ title, scenes: scenes.map(sentScene), avatarId: avatar.id, voiceId: voice.id, aspect, resolution, captions, ...(captions && !isDefaultCaptionStyle ? { captionStyle } : {}), speed, ...(pitch ? { pitch } : {}), ...(emotion ? { emotion } : {}), ...motion, ...(sentAccent ? { accent: sentAccent } : {}), ...(avatarEngine !== "avatar_iv" && avatarVInUse ? { avatarEngine, ...(moreBlinking ? { moreBlinking: true } : {}) } : {}), ...(sentTransparent ? { transparent: true } : {}) }),
      });
      sent.current = true;
      if (editKey) writeDraft(editKey, null);
      router.push(`/videos/${video.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start the render");
      setSubmitting(false);
    }
  }

  // Ctrl/Cmd+Enter generates from anywhere in the editor, with every setting as it is now (the handler reads
  // the latest render function rather than the one from when it was attached).
  const generateNow = useRef(generate);
  generateNow.current = generate;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canGenerate) {
        e.preventDefault();
        generateNow.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canGenerate]);

  const stageAspect = aspect === "9:16" ? "aspect-[9/16]" : aspect === "1:1" ? "aspect-square" : "aspect-video";
  // A transparent stage is drawn as a light checkerboard, whatever background the scene keeps.
  // A scene's clip that is gone or not ready (once the list has loaded) is said under the picker, before Generate.
  const clipMissing = !!footageData && !!footageIdOf(background) && !readyFootage.some((f) => f.id === footageIdOf(background));
  // A clip finished on the B-roll page since the editor opened is offered once the Background tab is opened again.
  useEffect(() => {
    if (tab === "background") void refetchFootage();
  }, [tab, refetchFootage]);
  const bgIsDark = !sentTransparent && ((background.type === "color" && isDarkHex(background.value)) || background.type === "video");

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
      {unfilled.length > 0 && (
        <div role="status" data-testid="unfilled-placeholders" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          Fill in {unfilled.slice(0, 4).join(", ")}
          {unfilled.length > 4 ? ` and ${unfilled.length - 4} more` : ""} with your own words: if the video is generated as it is, the presenter reads {unfilled.length === 1 ? "it" : "them"} out as written.
        </div>
      )}
      {fromAgent && (
        <div role="status" data-testid="agent-plan" className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-900">
          The Video Agent planned {scenes.length === 1 ? "this scene" : `these ${scenes.length} scenes`}. Review and edit them, then generate.
        </div>
      )}
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
          <input aria-label="Video title" className={`${inputClass} text-base font-medium`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Video title" />

          <Card className="overflow-hidden">
            {/* A portrait stage is sized by its height and takes its width from the ratio, so it really is 9:16 (a width-first box capped in height came out near square and cropped portrait slides); the height is also capped by the screen's width, so a narrow phone keeps the shape. */}
            <div data-testid="stage" className={`relative mx-auto ${aspect === "9:16" ? "h-[min(520px,70vh,calc((100vw_-_5rem)*16/9))] max-w-full" : "w-full"} ${stageAspect} flex items-end justify-center overflow-hidden [container-type:size]`} style={sentTransparent ? { backgroundColor: "#fff", backgroundImage: "repeating-conic-gradient(#e2e8f0 0 25%, #fff 0 50%)", backgroundSize: "24px 24px" } : background.type === "color" ? { background: background.value } : background.type === "image" ? { backgroundImage: `url(${background.value})`, backgroundSize: background.fit ?? "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat", backgroundColor: "#000" } : { background: background.fit ? "#000" : "#0f172a" }} data-fit={background.type === "color" ? undefined : (background.fit ?? "cover")} data-transparent={sentTransparent ? "" : undefined}>
              {/* Only a complete URL is previewed, so a half-typed one is not requested keystroke by keystroke. */}
              {!sentTransparent && background.type === "video" && (/^https?:\/\/\S+\.\S+/.test(background.value) || footageIdOf(background)) && (
                <video key={background.value} src={background.value} muted loop autoPlay playsInline aria-hidden="true" data-testid="stage-video" className={`absolute inset-0 h-full w-full ${background.fit === "contain" ? "object-contain" : "object-cover"}`} />
              )}
              {active.hidePresenter ? null : sceneAvatar ? (
                // The offset moves a frame-sized layer so one unit is half the frame on either axis; the scale stays on the portrait.
                // A close-up zooms toward the head and shoulders; a circle crops the portrait into a disc over the background.
                <div data-testid="stage-presenter" data-framing={framing} className={`absolute inset-0 flex justify-center ${framing === "circle" ? "items-center" : "items-end"}`} style={{ transform: `translate(${layout.x * 50}%, ${layout.y * 50}%)` }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                  data-testid="stage-avatar"
                  src={sceneAvatar.imageUrl}
                  alt={sceneAvatar.name}
                  className={framing === "circle" ? `${aspect === "16:9" ? "h-[60%]" : "w-[55%]"} aspect-square rounded-full bg-white/70 object-cover object-top shadow-xl ring-4 ring-white/80` : `${aspect === "16:9" ? "h-[92%]" : "h-[80%]"} max-w-[80%] object-contain object-bottom drop-shadow-xl`}
                  style={{ transform: `scale(${framing === "closeUp" ? layout.scale * 1.8 : layout.scale})`, transformOrigin: framing === "closeUp" ? "center 20%" : framing === "circle" ? "center" : "bottom center" }}
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
              {active.overlay?.text.trim() && (
                // Placed and sized as a share of the frame, as the renderer places it, so the preview holds at any stage size.
                <div
                  data-testid="stage-text"
                  data-position={active.overlay.position ?? "top"}
                  // One line, as the renderer draws it: text too long for the frame runs off it here too, and the editor says so.
                  className="pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-center font-bold leading-tight [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]"
                  style={{ top: `${SCENE_TEXT_Y[active.overlay.position ?? "top"] * 100}%`, fontSize: `${SCENE_TEXT_SCALE[active.overlay.size ?? "medium"] * 100}cqmin`, color: active.overlay.color ?? "#ffffff", fontFamily: "Arial, Helvetica, sans-serif" }}
                >
                  {active.overlay.text.replace(/\s+/g, " ").trim()}
                </div>
              )}
              {captions && stripPauses(active.script).trim() && (
                <div
                  data-testid="stage-caption"
                  className={`absolute ${captionStyle.position === "top" ? "top-4" : "bottom-4"} left-1/2 max-w-[85%] -translate-x-1/2 rounded-md px-3 py-1.5 text-center ${captionStyle.size === "small" ? "text-xs" : captionStyle.size === "large" ? "text-lg" : "text-sm"} ${stageLook(captionStyle.look ?? "classic", bgIsDark)}`}
                  data-look={captionStyle.look ?? "classic"}
                  data-font={captionStyle.font ?? "sans"}
                  style={{ fontFamily: CAPTION_FONT_STACKS[captionStyle.font ?? "sans"] }}
                >
                  {stripPauses(active.script).trim().split(/(?<=[.!?])\s+/)[0].slice(0, 90)}
                </div>
              )}
              <span className={`absolute left-3 ${(captions && captionStyle.position === "top") || (active.overlay?.text.trim() && (active.overlay.position ?? "top") === "top") ? "bottom-3" : "top-3"} rounded px-2 py-0.5 text-[11px] font-medium ${bgIsDark ? "bg-white/15 text-white" : "bg-black/10 text-slate-800"}`}>
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
                  ref={(el) => {
                    sceneTabs.current[i] = el;
                  }}
                  title={scenes.length > 1 && canEdit !== false ? "Drag onto another scene to move it there, or select it and use Move scene left or right" : undefined}
                  draggable={scenes.length > 1 && canEdit !== false && !slidesProgress}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData(SCENE_DRAG, String(i));
                    dragged.current = sc;
                    // After the browser has taken the tab's picture for the drag, so the picture is not the faded tab.
                    requestAnimationFrame(() => dragged.current === sc && setDragging(sc));
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(SCENE_DRAG)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropTarget !== i) setDropTarget(i);
                  }}
                  onDragLeave={(e) => {
                    // Moving over the tab's own dot or duration is not leaving it.
                    if (dropTarget === i && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
                  }}
                  onDrop={(e) => {
                    if (!e.dataTransfer.types.includes(SCENE_DRAG)) return;
                    e.preventDefault();
                    dropScene(i);
                  }}
                  onDragEnd={() => {
                    endDrag();
                    const to = focusAfterDrag.current;
                    focusAfterDrag.current = null;
                    if (to !== null) setTimeout(() => sceneTabs.current[to]?.focus(), 0);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                    i === activeIdx ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  } ${dragging === sc ? "opacity-50" : ""} ${dropTarget === i && dragging !== sc ? "ring-2 ring-brand-600 ring-offset-1" : ""}`}
                >
                  <span className="h-2.5 w-2.5 rounded-full border border-black/10" style={sc.background.type === "color" ? { background: sc.background.value } : sc.background.type === "video" ? { background: "linear-gradient(135deg,#0f172a,#475569)" } : { background: "linear-gradient(135deg,#94a3b8,#cbd5e1)" }} />
                  {i + 1}
                  {sc.script.trim() ? (
                    <span className={`font-normal ${i === activeIdx ? "text-brand-600" : "text-slate-500"}`} data-testid="scene-duration">{sc.audioId ? "" : "~"}{formatSeconds(Math.max(1, sceneSeconds(sc)))}</span>
                  ) : (
                    <span className="text-amber-700" title="Empty scene">•</span>
                  )}
                </button>
              ))}
              <button
                type="button"
                onClick={addScene}
                disabled={scenes.length >= MAX_SCENES}
                title={scenes.length >= MAX_SCENES ? `A video holds up to ${MAX_SCENES} scenes` : activeIdx < scenes.length - 1 ? `Add a scene after scene ${activeIdx + 1}` : undefined}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" /> Add scene
              </button>
              <button
                type="button"
                onClick={() => importInput.current?.click()}
                disabled={!!slidesProgress}
                title="A plain-text, Markdown, or Word file: each paragraph, or each part between headings or --- lines, becomes a scene"
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700 disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" /> Import script
              </button>
              <button
                ref={conversationButton}
                type="button"
                onClick={() => (conversationOpen ? closeConversation() : setConversationOpen(true))}
                disabled={canEdit === false || !!slidesProgress}
                aria-expanded={conversationOpen}
                aria-controls={conversationOpen ? CONVERSATION_PANEL_ID : undefined}
                title="Paste a conversation between two or more people: each turn becomes a scene, spoken by its speaker's presenter and voice"
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700 disabled:opacity-50"
              >
                <MessagesSquare className="h-3.5 w-3.5" /> Conversation
              </button>
              {brandData?.brand?.closingScene && (
                <button
                  type="button"
                  onClick={addClosingScene}
                  disabled={canEdit === false || !!slidesProgress}
                  title="Add the brand kit's closing scene at the end: its words, on the brand background, with its text on screen"
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700 disabled:opacity-50"
                >
                  <Flag className="h-3.5 w-3.5" /> Closing scene
                </button>
              )}
              <button
                type="button"
                onClick={() => slidesInput.current?.click()}
                disabled={canEdit !== true || !!slidesProgress}
                title="Each slide becomes a scene. A PDF puts each page behind the presenter; a PowerPoint (.pptx) file gives each scene its speaker notes as the script. Choose both files of a deck for both."
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700 disabled:opacity-50"
              >
                <ImageIcon className="h-3.5 w-3.5" /> {slidesProgress ?? "Import slides"}
              </button>
              <input
                ref={slidesInput}
                type="file"
                accept={`.pdf,.pptx,application/pdf,${PPTX_TYPE}`}
                multiple
                aria-label="Import slides from a PDF or PowerPoint file"
                className="hidden"
                onChange={(e) => {
                  void importDeck([...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
              <input
                ref={importInput}
                type="file"
                accept={`.txt,.md,.markdown,.docx,text/plain,text/markdown,${DOCX_TYPE}`}
                aria-label="Import a script file"
                className="hidden"
                onChange={(e) => {
                  void importScript(e.target.files?.[0]);
                  // The same file can be imported again after editing it.
                  e.target.value = "";
                }}
              />
              <span className="ml-auto flex items-center gap-1">
                <button
                  ref={undoButton}
                  type="button"
                  onClick={() => stepHistory("undo")}
                  disabled={!sceneHistory.past.length}
                  aria-label={sceneHistory.past.length ? `Undo ${sceneHistory.past[sceneHistory.past.length - 1].label}` : "Undo"}
                  title="Undo the last scene change (Ctrl+Z, or ⌘Z on a Mac, outside a text field)"
                  className="rounded-full p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                >
                  <Undo2 className="h-4 w-4" />
                </button>
                <button
                  ref={redoButton}
                  type="button"
                  onClick={() => stepHistory("redo")}
                  disabled={!sceneHistory.future.length}
                  aria-label={sceneHistory.future.length ? `Redo ${sceneHistory.future[sceneHistory.future.length - 1].label}` : "Redo"}
                  title="Redo the scene change undone (Ctrl+Shift+Z or Ctrl+Y, or ⌘⇧Z on a Mac, outside a text field)"
                  className="rounded-full p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                >
                  <Redo2 className="h-4 w-4" />
                </button>
                {scenes.length > 1 && (
                  <>
                    <button ref={moveLeft} type="button" onClick={() => { moveScene(activeIdx, -1); if (activeIdx === 1) requestAnimationFrame(() => moveRight.current?.focus()); }} disabled={activeIdx === 0} aria-label="Move scene left" title="Move scene earlier" className="rounded-full p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button ref={moveRight} type="button" onClick={() => { moveScene(activeIdx, 1); if (activeIdx === scenes.length - 2) requestAnimationFrame(() => moveLeft.current?.focus()); }} disabled={activeIdx === scenes.length - 1} aria-label="Move scene right" title="Move scene later" className="rounded-full p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </>
                )}
                <button type="button" onClick={() => duplicateScene(activeIdx)} disabled={scenes.length >= MAX_SCENES} aria-label="Duplicate scene" title="Duplicate this scene" className="rounded-full p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40">
                  <Copy className="h-4 w-4" />
                </button>
                {scenes.length > 1 && (
                  <button
                    type="button"
                    onClick={mergeWithNext}
                    disabled={canEdit === false || activeIdx >= scenes.length - 1 || !!active.audioId || !!scenes[activeIdx + 1]?.audioId}
                    aria-label="Merge with next scene"
                    title={active.audioId || scenes[activeIdx + 1]?.audioId ? "A scene that plays a recorded clip cannot be merged" : "Join the next scene's words to this one"}
                    className="rounded-full p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                  >
                    <Merge className="h-4 w-4" />
                  </button>
                )}
                {scenes.length > 1 && (
                  <button type="button" onClick={() => removeScene(activeIdx)} aria-label="Remove scene" className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-slate-500 hover:bg-rose-50 hover:text-rose-700">
                    <Trash2 className="h-3.5 w-3.5" /> Remove scene {activeIdx + 1}
                  </button>
                )}
              </span>
            </div>
            {conversationOpen && (
              <ConversationImport
                avatars={avatarsSorted}
                voices={voiceData?.voices ?? []}
                videoAvatar={avatar}
                videoVoice={voice}
                onMake={makeConversation}
                onCancel={closeConversation}
              />
            )}
            {importNote && (
              <p role="status" className="-mt-1 mb-3 flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="import-note">
                <span>{importNote}</span>
                <button type="button" onClick={() => setImportNote(null)} aria-label="Dismiss" className="rounded p-0.5 text-slate-500 hover:text-slate-700">
                  <X className="h-3.5 w-3.5" />
                </button>
              </p>
            )}
            <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="scene-show-presenter">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-brand-600"
                  checked={!active.hidePresenter}
                  disabled={canEdit === false || (background.type === "color" && !active.hidePresenter)}
                  aria-describedby="show-presenter-hint"
                  onChange={(e) => updateScene(activeIdx, { hidePresenter: e.target.checked ? undefined : true })}
                />
                <span className="font-medium text-slate-700">Show the presenter{scenes.length > 1 ? ` in scene ${activeIdx + 1}` : ""}</span>
              </label>
              <p id="show-presenter-hint" className="ml-5 text-slate-500">
                {background.type === "color"
                  ? "To show only a picture or video here, give the scene an image or video background first."
                  : active.hidePresenter
                  ? `The ${background.type === "video" ? "video" : "picture"} fills the frame and ${active.audioId ? "the clip plays" : silentSeconds(active.script) ? "holds in silence" : "the voice narrates it"}. HeyGen renders it; D-ID cannot and refuses the video.`
                  : `Turn off to let the ${background.type === "video" ? "video" : "picture"} fill the frame, with the voice over it.`}
              </p>
            </div>
            {scenes.length > 1 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="scene-presenter">
                <span className="font-medium">Scene {activeIdx + 1} {active.hidePresenter ? "voice" : "presenter"}</span>
                {!active.hidePresenter && <select aria-label="Scene avatar" className={`${inputClass} w-auto py-1 text-xs`} value={active.avatarId ?? ""} onChange={(e) => {
                  const picked = avatarData?.avatars.find((a) => a.id === e.target.value);
                  // A presenter's default voice comes along unless the scene already has a voice of its own.
                  const voiceId = picked?.defaultVoiceId && !active.voiceId && voiceData?.voices.some((v) => v.id === picked.defaultVoiceId) ? picked.defaultVoiceId : active.voiceId;
                  updateScene(activeIdx, { avatarId: e.target.value || undefined, voiceId });
                }}>
                  <option value="">{avatar ? `Video avatar (${avatar.name})` : "Video avatar"}</option>
                  {(avatarData?.avatars ?? []).map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>}
                {!active.audioId && !silentSeconds(active.script) && (
                  // HeyGen speaks each scene at its own pace, as its studio lets each scene set one.
                  <select aria-label="Scene speed" title="HeyGen speaks this scene at its own pace; D-ID keeps its natural pace" className={`${inputClass} w-auto py-1 text-xs`} value={active.speed ?? ""} onChange={(e) => updateScene(activeIdx, { speed: e.target.value ? Number(e.target.value) : undefined })}>
                    <option value="">{`Video speed (${speed.toFixed(2)}x)`}</option>
                    {/* "Video speed" follows the slider; a pace picked here, the slider's own included, stays whatever the slider says later. */}
                    {[...new Set([...SCENE_SPEEDS, ...(active.speed ? [active.speed] : [])])].sort((x, y) => x - y).map((v) => (
                      <option key={v} value={v}>{`${v.toFixed(2)}x`}</option>
                    ))}
                  </select>
                )}
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
            {!active.hidePresenter && <details className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="scene-layout">
              <summary className="cursor-pointer select-none font-medium text-slate-700">
                Presenter layout{isDefaultLayout(shownLayout) ? "" : ` · ${[framing !== "full" ? FRAMING_LABELS[framing].toLowerCase() : "", layout.scale !== 1 ? `${Math.round(layout.scale * 100)}%` : "", layout.x || layout.y ? "moved" : ""].filter(Boolean).join(", ")}`}
              </summary>
              <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Presenter framing">
                <span className="mr-1">Framing</span>
                {PRESENTER_FRAMINGS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={framing === f}
                    disabled={f === "closeUp" && photoPresenter}
                    title={f === "closeUp" && photoPresenter ? "A photo avatar has no close-up" : undefined}
                    onClick={() => setLayout({ ...layout, framing: f })}
                    className={`rounded-md border px-2 py-1 ${framing === f ? "border-brand-600 bg-brand-50 text-brand-700" : "border-slate-200 bg-white hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-50"}`}
                  >
                    {FRAMING_LABELS[f]}
                  </button>
                ))}
              </div>
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
                <span className="text-slate-500">Applies to this scene in the preview and is kept with it. HeyGen and D-ID place the presenter themselves, so the rendered video uses their framing.</span>
                {!isDefaultLayout(shownLayout) && (
                  <button type="button" onClick={() => setLayout(DEFAULT_LAYOUT)} className="text-brand-700 hover:underline">
                    Reset
                  </button>
                )}
              </div>
            </details>}
            <SceneAudio
              // Distinct from the script box's key: both sit among the same siblings.
              key={`audio-${activeIdx}`}
              clips={clips}
              clipId={active.audioId}
              script={active.script}
              disabled={canEdit === false}
              // A clip whose words are known fills a scene that has none yet, or still has the last clip's words; words
              // typed are kept. Those of a clip taken away go with it, so a voice never reads them by mistake.
              onUse={(clip) => {
                const wordsOfClip = clipWords(active);
                const script = clip.transcript && (!active.script.trim() || wordsOfClip) ? clip.transcript : wordsOfClip ? "" : null;
                updateScene(activeIdx, { audioId: clip.id, voiceId: undefined, ...(script !== null ? { script } : {}) });
              }}
              onClear={() => updateScene(activeIdx, { audioId: undefined, ...(clipWords(active) ? { script: "" } : {}) })}
              // A new clip goes first, as the list is newest first; an edited one stays where it is.
              onSaved={(clip) => setClipData((prev) => ({ clips: prev?.clips.some((c) => c.id === clip.id) ? prev.clips.map((c) => (c.id === clip.id ? clip : c)) : [clip, ...(prev?.clips ?? [])] }))}
            />
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">
                {active.audioId ? (scenes.length > 1 ? `Scene ${activeIdx + 1}: what the clip says` : "What the clip says") : scenes.length > 1 ? `Scene ${activeIdx + 1} script` : "Script"}
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500" data-testid="script-length">
                  {!active.audioId && silentSeconds(active.script)
                    ? `Silent scene: the ${active.hidePresenter ? (background.type === "video" ? "video plays" : "picture holds") : "presenter holds"} for ${formatSeconds(silentSeconds(active.script))}${scenes.length > 1 ? ` · ~${formatSeconds(seconds)} total` : ""}`
                    : scenes.length > 1
                    ? `${wordCount(active.script)} words · ~${formatSeconds(sceneSeconds(active))} this scene · ~${formatSeconds(seconds)} total`
                    : `${words} words · ~${formatSeconds(seconds)}`}
                </span>
                {silentIssue && (
                  <span role="alert" className="text-xs font-medium text-rose-600">
                    {silentIssue}
                  </span>
                )}
                {rewriteErr && (
                  <span role="alert" className="text-xs font-medium text-rose-600">
                    {rewriteErr}
                  </span>
                )}
                {rewriteUndo && scenes[activeIdx] === rewriteUndo.scene && (
                  <span className="inline-flex items-center gap-2 text-xs text-slate-600" role="status">
                    {rewriteUndo.note}
                    <button
                      type="button"
                      aria-label="Undo the rewrite"
                      className="font-medium text-brand-700 underline"
                      onClick={() => {
                        const { scene, before } = rewriteUndo;
                        setScenes((prev) => prev.map((sc) => (sc === scene ? { ...sc, script: before } : sc)));
                        setRewriteUndo(null);
                        scriptRef.current?.focus();
                      }}
                    >
                      Undo
                    </button>
                  </span>
                )}
                {!allScenesFilled && scenes.every((sc) => sc.script.trim()) && (
                  <span role="alert" className="text-xs font-medium text-rose-600">
                    Every scene is silent; give at least one some words
                  </span>
                )}
                {scriptTooLong && (
                  <span role="alert" className="text-xs font-medium text-rose-600" data-testid="script-too-long">
                    {scriptChars} of {MAX_SCRIPT_CHARS} characters; shorten the script to generate
                  </span>
                )}
                <Button ref={writerButton} variant="secondary" className="px-3 py-1.5" aria-expanded={writerOpen} onClick={() => setWriterOpen((v) => !v)}>
                  <Wand2 className="h-4 w-4" /> Write with AI
                </Button>
                <Button
                  ref={findButton}
                  variant="secondary"
                  className="px-3 py-1.5"
                  aria-expanded={findOpen}
                  aria-controls="find-replace"
                  disabled={canEdit === false}
                  onClick={() => {
                    setFindOpen((v) => !v);
                    setFindDone(null);
                    setFindIssue(null);
                    requestAnimationFrame(() => findInput.current?.focus());
                  }}
                >
                  <Replace className="h-4 w-4" /> Find
                </Button>
                <div
                  className="relative"
                  onKeyDown={(e) => {
                    if (e.key !== "Escape" || !assistOpen) return;
                    e.stopPropagation();
                    setAssistOpen(false);
                    improveButton.current?.focus();
                  }}
                >
                  <Button
                    ref={improveButton}
                    variant="secondary"
                    className="px-3 py-1.5"
                    disabled={!stripPauses(active.script).trim()}
                    loading={assistBusy}
                    aria-expanded={assistOpen}
                    aria-controls="improve-options"
                    onClick={() => setAssistOpen((v) => !v)}
                  >
                    <Sparkles className="h-4 w-4" /> Improve
                  </Button>
                  {assistOpen && (
                    <div id="improve-options" className="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
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
                        <select aria-label="New tone" className={`${inputClass} py-1.5 text-xs`} value={assistTone} onChange={(e) => setAssistTone(e.target.value as typeof assistTone)}>
                          {TONES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                        </select>
                        <button type="button" onClick={() => revise("tone")} className="shrink-0 rounded-md px-2 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50">Change tone</button>
                      </div>
                      <div className="mt-1 flex items-center gap-1 px-1">
                        <input aria-label="Translate to" className={`${inputClass} py-1.5 text-xs`} value={assistLanguage} onChange={(e) => setAssistLanguage(e.target.value)} placeholder="Language" />
                        <button type="button" onClick={() => revise("translate")} className="shrink-0 rounded-md px-2 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50">Translate</button>
                      </div>
                    </div>
                  )}
                </div>
                {!active.audioId && (
                  <Button variant="secondary" className="px-3 py-1.5" onClick={insertPause} disabled={canEdit === false} title="Insert a pause at the cursor; change the number to make it longer (up to 10 seconds). A scene of only pauses is a silent one, the presenter holding without a word">
                    <Pause className="h-4 w-4" /> Pause
                  </Button>
                )}
                {!active.audioId && (
                  <Button variant="secondary" className="px-3 py-1.5" onClick={splitActiveScene} disabled={canEdit === false} title="Split this scene at the cursor: the words after it become the next scene, with the same presenter, voice, and background">
                    <Scissors className="h-4 w-4" /> Split
                  </Button>
                )}
                {sceneVoice && !active.audioId && (
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5"
                    disabled={!stripPauses(active.script).trim()}
                    loading={busyId === sceneVoice.id}
                    onClick={() => play(sceneVoice, active.script.slice(0, 400).replace(/\[[^\]]*$/, ""), active.speed ?? speed).catch((e) => setErr(e.message))}
                  >
                    {playingId === sceneVoice.id ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {playingId === sceneVoice.id ? "Stop" : "Listen"}
                  </Button>
                )}
              </div>
            </div>
            {findOpen && (
              <FindReplace
                inputRef={findInput}
                // What a recorded clip says, and a silent scene, are left alone: changing them would not change the speech.
                scripts={scenes.map((sc) => (sc.audioId || silentSeconds(sc.script) ? "" : sc.script))}
                find={findText}
                replacement={replaceText}
                matchCase={findCase}
                wholeWord={findWhole}
                // The note (and Undo) stand only while the scripts are as the replacement left them.
                // A refusal is said first; either note stands only while the scripts are as it found them.
                note={(findIssue && findIssue.scripts === scenes.map((sc) => sc.script).join("\u0000") ? findIssue.note : null) ?? (findDone && findDone.after.join("\u0000") === scenes.map((sc) => sc.script).join("\u0000") ? findDone.note : null)}
                undoable={!!findDone && findDone.after.join("\u0000") === scenes.map((sc) => sc.script).join("\u0000")}
                skipped={[
                  scenes.some((sc) => sc.audioId) ? "recorded clips' transcripts" : "",
                  scenes.some((sc) => sc.overlay?.text.trim()) ? "on-screen text" : "",
                ].filter(Boolean)}
                busy={assistBusy}
                onUndo={() => {
                  if (!findDone) return;
                  const { before } = findDone;
                  setScenes((prev) => prev.map((sc, i) => (before[i] !== undefined && before[i] !== sc.script ? { ...sc, script: before[i] } : sc)));
                  setFindDone(null);
                  // The Undo button goes with what it undid; the focus goes back to the search.
                  requestAnimationFrame(() => findInput.current?.focus());
                }}
                onChange={(patch) => {
                  setFindDone(null);
                  setFindIssue(null);
                  if (patch.find !== undefined) setFindText(patch.find);
                  if (patch.replacement !== undefined) setReplaceText(patch.replacement);
                  if (patch.matchCase !== undefined) setFindCase(patch.matchCase);
                  if (patch.wholeWord !== undefined) setFindWhole(patch.wholeWord);
                }}
                onReplaceAll={() => {
                  if (assistBusy) return;
                  const before = scenes.map((sc) => sc.script);
                  const findable = scenes.map((sc) => !sc.audioId && !silentSeconds(sc.script));
                  const { scripts, count } = replaceAll(before.map((t, i) => (findable[i] ? t : "")), findText, replaceText, { matchCase: findCase, wholeWord: findWhole });
                  if (!count) return;
                  const after = before.map((t, i) => (findable[i] ? scripts[i] : t));
                  // Refused rather than made: a video holds MAX_SCRIPT_CHARS across its scenes, and Generate would then be blocked.
                  // A replacement that shortens a script already over the limit is still made.
                  const measure = (list: string[]) => list.map((t) => t.trim()).join("\n\n").length;
                  const length = measure(after);
                  if (length > MAX_SCRIPT_CHARS && length > measure(before)) {
                    setFindIssue({ note: `Not replaced: the script would be ${length} of ${MAX_SCRIPT_CHARS} characters`, scripts: before.join("\u0000") });
                    return;
                  }
                  setScenes((prev) => prev.map((sc, i) => (after[i] === sc.script ? sc : { ...sc, script: after[i] })));
                  setFindIssue(null);
                  setFindDone({ note: `Replaced ${count} ${count === 1 ? "match" : "matches"}.`, before, after });
                  // Replace all is disabled once nothing is left to replace; the focus goes back to the search.
                  requestAnimationFrame(() => findInput.current?.focus());
                }}
                onClose={() => {
                  setFindOpen(false);
                  setFindIssue(null);
                  findButton.current?.focus();
                }}
              />
            )}
            {writerOpen && (
              <ScriptWriter
                onClose={() => {
                  setWriterOpen(false);
                  writerButton.current?.focus();
                }}
                onScript={(s) => { if (applyRewrite(active, s, "Written by AI.")) setWriterOpen(false); }}
              />
            )}
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
            <SceneTextFields
              key={`text-${activeIdx}`}
              overlay={active.overlay}
              aspect={aspect}
              captionsAt={captions ? captionStyle.position : undefined}
              scene={scenes.length > 1 ? activeIdx + 1 : undefined}
              disabled={canEdit === false}
              onChange={(overlay) => updateScene(activeIdx, { overlay })}
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
                type="button"
                aria-pressed={tab === key}
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
                <AvatarGrid avatars={avatarsSorted} selectedId={avatar?.id} onSelect={pickAvatar} compact favoriteIds={favorites.avatarIds} onToggleFavorite={favorites.canToggle ? (a) => favorites.toggle("avatar", a.id) : undefined} />
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
                        onPreview={() => play(v, previewText || "Hi, this is a preview of my voice.", speed).catch((e) => setErr(e.message))}
                        favorite={favorites.voiceIds.has(v.id)}
                        onToggleFavorite={favorites.canToggle ? () => favorites.toggle("voice", v.id) : undefined}
                      />
                    ))}
              </div>
            )}

            {tab === "background" && (
              <div className="space-y-5">
                {scenes.length > 1 && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="background-scope">
                    <p>Editing the background for scene {activeIdx + 1}. Each scene keeps its own background.</p>
                    {scenes.every((sc) => backgroundsMatch(sc.background, background)) ? (
                      <p className="text-slate-500">All of them have this one for now.</p>
                    ) : (
                      <Button
                        variant="secondary"
                        className="px-3 py-1.5"
                        onClick={applyBackgroundEverywhere}
                        disabled={canEdit === false || !!slidesProgress || clipMissing}
                        aria-describedby={clipMissing ? "generated-clip-hint" : undefined}
                        title={canEdit === false ? undefined : clipMissing ? "This scene's clip is gone or not ready; choose another background first" : "Give the other scenes this background (and its fit); Undo takes it back"}
                      >
                        Use on every scene
                      </Button>
                    )}
                  </div>
                )}
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
                <BackdropPicker
                  value={background}
                  onChange={setBackground}
                  backdrops={backdropData?.backdrops ?? []}
                  setBackdrops={(update) => setBackdropData((d) => ({ backdrops: update(d?.backdrops ?? []) }))}
                  loadError={backdropError}
                  canEdit={canEdit !== false}
                />
                {background.type !== "color" && (
                  // The preview can show a picture whole; HeyGen's current API always fills the frame, so renders crop it.
                  <div role="group" aria-label="Background fit">
                    <div className="mb-2 text-sm font-medium text-slate-700">Fit</div>
                    <div className="grid grid-cols-2 gap-2">
                      {(["cover", "contain"] as const).map((f) => (
                        <button
                          key={f}
                          type="button"
                          aria-pressed={(background.fit ?? "cover") === f}
                          onClick={() => updateScene(activeIdx, { background: f === "contain" ? { ...background, fit: f } : { type: background.type, value: background.value } })}
                          className={`rounded-lg border px-3 py-2 text-left text-sm font-medium ${(background.fit ?? "cover") === f ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}
                        >
                          {f === "cover" ? "Fill the frame" : "Show all of it"}
                          <div className="text-[11px] font-normal text-slate-600">{f === "cover" ? "Cropped to the frame's shape" : "Whole, with plain bars, in the preview; renders fill the frame"}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <Field label="Image URL" hint="A public image URL. Shown behind the avatar.">
                  <div className="flex gap-2">
                    <input
                      className={inputClass}
                      placeholder="https://…/background.jpg"
                      value={background.type === "image" && !backdropIdOf(background) ? background.value : ""}
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
                      value={background.type === "video" && !footageIdOf(background) ? background.value : ""}
                      onChange={(e) => setBackground(e.target.value ? { type: "video", value: e.target.value } : DEFAULT_BG)}
                    />
                    <span className="flex items-center text-slate-400"><Clapperboard className="h-5 w-5" /></span>
                  </div>
                </Field>
                {(footageData?.footage.length || footageIdOf(background)) && (
                  // A clip made on the B-roll page loops behind the presenter; the render looks up a fresh link for it.
                  <div>
                    <label htmlFor="generated-clip" className="mb-1.5 block text-sm font-medium text-slate-700">
                      Generated clip
                    </label>
                    <select
                      id="generated-clip"
                      aria-describedby="generated-clip-hint"
                      className={inputClass}
                      value={footageIdOf(background) ?? ""}
                      onChange={(e) => setBackground(e.target.value ? { type: "video", value: footagePath(e.target.value) } : DEFAULT_BG)}
                    >
                      <option value="">None</option>
                      {readyFootage.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.title} ({footageLength(f)}{f.aspect ? `, ${f.aspect}` : ""})
                        </option>
                      ))}
                      {footageIdOf(background) && !readyFootage.some((f) => f.id === footageIdOf(background)) && <option value={footageIdOf(background)!}>A clip that is gone or not ready</option>}
                    </select>
                    {/* The hint sits outside the label, so the list's name is "Generated clip" alone. */}
                    <p id="generated-clip-hint" className={`mt-1 text-xs ${clipMissing ? "text-rose-600" : "text-slate-500"}`}>
                      {clipMissing
                        ? "This scene's clip is gone or not ready, so the video cannot render; choose another background, or wait for the clip on the B-roll page."
                        : readyFootage.length
                          ? "A clip made on the B-roll page, looped behind the avatar. HeyGen plays it."
                          : "No finished clips yet; make one on the B-roll page."}
                    </p>
                  </div>
                )}
              </div>
            )}

            {tab === "settings" && (
              <div className="space-y-5">
                <div role="group" aria-label="Aspect ratio">
                  <div className="mb-2 text-sm font-medium text-slate-700">Aspect ratio</div>
                  <div className="grid grid-cols-3 gap-2">
                    {(["16:9", "9:16", "1:1"] as AspectRatio[]).map((a) => (
                      <button
                        key={a}
                        type="button"
                        aria-pressed={aspect === a}
                        onClick={() => setAspect(a)}
                        className={`rounded-lg border px-3 py-3 text-sm font-medium ${aspect === a ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}
                      >
                        {a}
                        <div className="text-[11px] font-normal text-slate-600">{a === "16:9" ? "Landscape" : a === "9:16" ? "Portrait" : "Square"}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <div role="group" aria-label="Output quality">
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
                        <div className="text-[11px] font-normal text-slate-600">{r === "720p" ? "HD · faster, smaller file" : "Full HD · best quality"}</div>
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
                <Field
                  label="Voice emotion"
                  hint="Kept with the video and its templates. HeyGen's current API takes no emotion, so every renderer speaks with the voice's natural delivery."
                >
                  <select value={emotion} onChange={(e) => setEmotion(asEmotion(e.target.value))} aria-label="Voice emotion" className={inputClass}>
                    <option value="">Natural</option>
                    {VOICE_EMOTIONS.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Accent"
                  hintId="accent-hint"
                  hint={
                    !voiceData
                      ? "For voices that speak several accents of their language; HeyGen applies it."
                      : accentVoices.length
                        ? `How ${(accentTakers.length ? accentTakers : accentVoices).map((v) => v.name).join(" and ")} ${(accentTakers.length ? accentTakers : accentVoices).length > 1 ? "pronounce" : "pronounces"} the script. HeyGen applies it; other renderers, and scenes whose voice offers no accents or speaks another language, keep the voice's own.`
                        : "For voices that speak several accents of their language; no voice in this video offers one, so none is sent."
                  }
                >
                  <select value={accent} onChange={(e) => setAccent(asAccent(e.target.value))} disabled={!!voiceData && !accentVoices.length && !accent} aria-label="Accent" aria-describedby="accent-hint" className={inputClass}>
                    <option value="">{accentVoices.length || !voiceData ? "The voice's own" : "None to choose"}</option>
                    {accentOptions.map((a) => (
                      <option key={a} value={a}>
                        {languageLabel(a)} ({a})
                      </option>
                    ))}
                    {accent && !accentOptions.includes(accent) ? (
                      <option value={accent}>{voiceData ? `${languageLabel(accent)} (${accent}), not sent: no voice here takes it` : `${languageLabel(accent)} (${accent})`}</option>
                    ) : null}
                  </select>
                </Field>
                <Field
                  label="Avatar engine"
                  hintId="avatar-engine-hint"
                  hint={
                    !avatarData || avatarVInUse
                      ? "Avatar V is HeyGen's higher-quality engine, for looks that support it; other presenters, and photo avatars given expressiveness or gestures, stay on Avatar IV. Other renderers ignore it."
                      : "No presenter in this video renders on Avatar V (none supports it, or a photo avatar has motion settings), so every scene uses Avatar IV."
                  }
                >
                  <select value={avatarEngine} onChange={(e) => setAvatarEngine(asAvatarEngine(e.target.value))} disabled={!!avatarData && !avatarVInUse && avatarEngine === "avatar_iv"} aria-label="Avatar engine" aria-describedby="avatar-engine-hint" className={inputClass}>
                    <option value="avatar_iv">Avatar IV (standard)</option>
                    <option value="avatar_v">{!avatarData || avatarVInUse ? "Avatar V (higher quality)" : "Avatar V (not sent: no presenter here renders on it)"}</option>
                  </select>
                </Field>
                <label className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 px-3 py-3">
                  <span>
                    <span className="block text-sm font-medium text-slate-800">More blinking</span>
                    <span id="more-blinking-hint" className="block text-xs text-slate-500">
                      {avatarEngine !== "avatar_v"
                        ? moreBlinking
                          ? "Not sent on Avatar IV; kept for when you choose Avatar V above."
                          : "An Avatar V setting, for presenters that blink too little; choose Avatar V above to use it."
                        : avatarData && !avatarVInUse
                          ? "Not sent: no presenter in this video renders on Avatar V."
                          : "HeyGen's Avatar V blinks more naturally, for presenters that blink too little; scenes on Avatar IV keep their own blinking. Other renderers ignore it."}
                    </span>
                  </span>
                  <input type="checkbox" checked={moreBlinking} onChange={(e) => setMoreBlinking(e.target.checked)} disabled={avatarEngine !== "avatar_v" && !moreBlinking} aria-label="More blinking" aria-describedby="more-blinking-hint" className="mt-1 h-5 w-5 shrink-0 accent-brand-600" />
                </label>
                <label className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 px-3 py-3">
                  <span>
                    <span className="block text-sm font-medium text-slate-800">Transparent background</span>
                    <span id="transparent-hint" className="block text-xs text-slate-500">
                      {canTransparent
                        ? "HeyGen renders the presenter alone as a WebM with an alpha channel, for compositing over your own footage; the scene background and burned-in captions are left out. The avatar must be trained with matting, which HeyGen checks: it refuses others (likely photo avatars and uploaded portraits), and D-ID cannot render one. Captions stay on the share page's subtitle track."
                        : scenes.length > 1
                          ? "For a one-scene video that shows the presenter; this one has more than one scene, so it renders with its backgrounds."
                          : "For a one-scene video that shows the presenter; this scene leaves the presenter out, so it renders with its background."}
                    </span>
                  </span>
                  <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} disabled={!canTransparent && !transparent} aria-label="Transparent background" aria-describedby="transparent-hint" className="mt-1 h-5 w-5 shrink-0 accent-brand-600" />
                </label>
                <div role="group" aria-labelledby="photo-motion-title" className="space-y-2 rounded-lg border border-slate-200 px-3 py-3" data-testid="photo-motion">
                  <div id="photo-motion-title" className="text-sm font-medium text-slate-800">Avatar motion</div>
                  <p id="photo-motion-hint" className="text-xs text-slate-500">
                    {photoInUse || !avatarData
                      ? `How a photo avatar moves as it speaks, on HeyGen (Avatar IV).${gesturesOnV ? " Gestures also reach the video avatars rendering on Avatar V." : ""} Other presenters keep their own motion, and D-ID and the demo renderer ignore it.`
                      : gesturesOnV
                        ? "Gestures reach the video avatars rendering on Avatar V, on HeyGen; expressiveness is for photo avatars (an uploaded portrait or a HeyGen photo avatar), and no scene shows one now."
                        : videoLookOnV
                          ? "For photo avatars (an uploaded portrait or a HeyGen photo avatar), and gestures also for video avatars on Avatar V; choose Avatar V above for gestures to reach this video's presenter."
                          : "For photo avatars (an uploaded portrait or a HeyGen photo avatar), and gestures also for video avatars on Avatar V; no scene shows either now, so nothing here applies yet."}
                  </p>
                  <Field label="Expressiveness">
                    <select value={expressiveness} onChange={(e) => setExpressiveness(asExpressiveness(e.target.value))} aria-describedby="photo-motion-hint" className={inputClass}>
                      <option value="low">Low (natural)</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </Field>
                  <Field label="Gestures (optional)">
                    <input
                      value={motionPrompt}
                      onChange={(e) => setMotionPrompt(e.target.value)}
                      maxLength={MAX_MOTION_PROMPT}
                      placeholder="Nods warmly and gestures toward the room with an open hand"
                      aria-describedby="photo-motion-hint"
                      className={inputClass}
                    />
                  </Field>
                </div>
                <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-3">
                  <span>
                    <span className="block text-sm font-medium text-slate-800">Captions</span>
                    <span className="block text-xs text-slate-500">{sentTransparent ? "Subtitles on the share page (nothing is burned over a transparent video)." : "Burn subtitles into the video."}</span>
                  </span>
                  <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} className="h-5 w-5 accent-brand-600" />
                </label>
                {captions && (
                  <div className="rounded-lg border border-slate-200 px-3 py-3" data-testid="caption-style">
                    <div className="text-sm font-medium text-slate-800">Caption style</div>
                    <div className="mt-0.5 text-xs text-slate-500">Where subtitles sit, how big they read, and how they look in the share player. The WebVTT file carries the position as a cue setting; the SRT download carries none of the style. A renderer that burns captions into the video leaves them off, so this style is the only one and the downloaded video carries no captions.</div>
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
                      <div role="group" aria-label="Caption look" className="flex gap-1 sm:col-span-2">
                        {CAPTION_LOOKS.map((look) => {
                          const on = (captionStyle.look ?? "classic") === look;
                          return (
                            <button key={look} type="button" aria-pressed={on} onClick={() => setCaptionStyle(withoutDefaults({ ...captionStyle, look }))} className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium capitalize ${on ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}>
                              {look}
                            </button>
                          );
                        })}
                      </div>
                      <div role="group" aria-label="Caption font" className="flex gap-1 sm:col-span-2">
                        {CAPTION_FONTS.map((font) => {
                          const on = (captionStyle.font ?? "sans") === font;
                          return (
                            <button key={font} type="button" aria-pressed={on} onClick={() => setCaptionStyle(withoutDefaults({ ...captionStyle, font }))} style={{ fontFamily: CAPTION_FONT_STACKS[font] }} className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium capitalize ${on ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}>
                              {font}
                            </button>
                          );
                        })}
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
    <div
      className="mb-3 rounded-lg border border-brand-200 bg-brand-50/60 p-4"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-brand-800"><Wand2 className="h-4 w-4" /> AI script writer</div>
        <button type="button" onClick={onClose} aria-label="Close the script writer" className="text-slate-500 hover:text-slate-900"><X className="h-4 w-4" /></button>
      </div>
      <div className="space-y-3">
        <input className={inputClass} aria-label="Topic" autoFocus placeholder="What is the video about? e.g. Welcome new tenants to our property portal" value={topic} onChange={(e) => setTopic(e.target.value)} />
        <input className={inputClass} type="url" aria-label="Page URL" placeholder="Or paste a public web page to write from (a listing, a blog post, a product page)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-3">
          <select aria-label="Tone" className={inputClass} value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}>
            {TONES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
          </select>
          <select aria-label="Length" className={inputClass} value={lengthSec} onChange={(e) => setLength(Number(e.target.value))}>
            {[15, 30, 45, 60, 90, 120].map((s) => <option key={s} value={s}>{s} seconds</option>)}
          </select>
          <input aria-label="Script language" className={inputClass} value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="Language" />
        </div>
        <input className={inputClass} aria-label="Audience" placeholder="Audience (optional), e.g. first-time landlords" value={audience} onChange={(e) => setAudience(e.target.value)} />
        <ErrorBanner message={err} />
        <div className="flex justify-end">
          <Button onClick={run} loading={busy} disabled={topic.trim().length < 3 && !url.trim()}>Write script</Button>
        </div>
      </div>
    </div>
  );
}

/** The find-and-replace panel: what to look for across every scene, what to put instead, and how many it finds. */
function FindReplace({
  inputRef,
  scripts,
  find,
  replacement,
  matchCase,
  wholeWord,
  note,
  undoable,
  skipped,
  busy,
  onChange,
  onReplaceAll,
  onUndo,
  onClose,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  scripts: string[];
  find: string;
  replacement: string;
  matchCase: boolean;
  wholeWord: boolean;
  /** What the last Replace all did or why it did nothing, while the scripts are as it left them. */
  note: string | null;
  /** Whether the last Replace all can still be undone. */
  undoable: boolean;
  /** What the editor holds that is not searched, named for the note under the fields. */
  skipped: string[];
  /** An Improve request is rewriting a scene; replacing now would be overwritten by its answer. */
  busy: boolean;
  onChange: (patch: { find?: string; replacement?: string; matchCase?: boolean; wholeWord?: boolean }) => void;
  onReplaceAll: () => void;
  onUndo: () => void;
  onClose: () => void;
}) {
  const counts = countMatches(scripts, find, { matchCase, wholeWord });
  const total = counts.reduce((a, b) => a + b, 0);
  const inScenes = counts.filter(Boolean).length;
  const status = note ?? (busy ? "Waiting for Improve to finish" : !find ? "" : total ? `${total} ${total === 1 ? "match" : "matches"}${scripts.length > 1 ? ` in ${inScenes} ${inScenes === 1 ? "scene" : "scenes"}` : ""}` : "No matches");
  return (
    <div
      id="find-replace"
      role="group"
      aria-label="Find and replace"
      className="mb-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          ref={inputRef}
          aria-label="Find"
          aria-describedby={skipped.length ? "find-skipped" : undefined}
          placeholder="Find in every scene's script"
          value={find}
          onChange={(e) => onChange({ find: e.target.value })}
          onKeyDown={(e) => {
            // Enter moves on to the replacement, where Enter replaces.
            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              (e.currentTarget.parentElement?.querySelector('input[aria-label="Replace with"]') as HTMLInputElement | null)?.focus();
            }
          }}
          className={inputClass}
          maxLength={200}
        />
        <input
          aria-label="Replace with"
          placeholder="Replace with"
          value={replacement}
          onChange={(e) => onChange({ replacement: e.target.value })}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter is the editor's Generate shortcut, not Replace all.
            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing && total && !busy) {
              e.preventDefault();
              onReplaceAll();
            }
          }}
          className={inputClass}
          maxLength={500}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={matchCase} onChange={(e) => onChange({ matchCase: e.target.checked })} className="accent-brand-600" /> Match case
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={wholeWord} onChange={(e) => onChange({ wholeWord: e.target.checked })} className="accent-brand-600" /> Whole words
        </label>
        <span role="status" className="min-w-0 flex-1 text-slate-500" data-testid="find-status">
          {status}
        </span>
        {undoable && (
          <Button variant="secondary" className="px-3 py-1.5" onClick={onUndo}>
            Undo
          </Button>
        )}
        <Button variant="secondary" className="px-3 py-1.5" disabled={!total || busy} onClick={onReplaceAll}>
          Replace all
        </Button>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-200" aria-label="Close find and replace">
          <X className="h-4 w-4" />
        </button>
      </div>
      {skipped.length > 0 && (
        <p id="find-skipped" className="text-xs text-slate-500">
          Searches the typed scripts; {skipped.join(" and ")} {skipped.length > 1 ? "are" : "is"} not changed.
        </p>
      )}
    </div>
  );
}

/** A scene's on-screen text: what it says, and where, how large, and in what colour it shows. Cleared text removes it. */
function SceneTextFields({ overlay, aspect, captionsAt, scene, disabled, onChange }: { overlay?: SceneText; aspect: AspectRatio; captionsAt?: CaptionStyle["position"]; scene?: number; disabled: boolean; onChange: (overlay: SceneText | undefined) => void }) {
  const id = useId();
  const text = overlay?.text ?? "";
  const shown = text.replace(/\s+/g, " ").trim();
  const position = overlay?.position ?? "top";
  const set = (patch: Partial<SceneText>) => {
    const next = { ...overlay, text, ...patch };
    onChange(next.text ? restoredOverlay(next) ?? { text: next.text } : undefined);
  };
  return (
    <div className="mt-3 space-y-2">
      <label className="block text-xs font-medium text-slate-600" htmlFor={id}>
        On-screen text{scene ? ` for scene ${scene}` : ""} <span className="font-normal text-slate-500">(optional: a title, a name and role, a price)</span>
      </label>
      <input
        id={id}
        aria-describedby={shown ? `${id}-notes` : undefined}
        className={inputClass}
        value={text}
        disabled={disabled}
        placeholder="Shown over the scene for its whole length"
        onChange={(e) => {
          // A composition (an input method building a character) is left alone until it ends.
          if ((e.nativeEvent as InputEvent).isComposing) return set({ text: e.target.value });
          const el = e.currentTarget;
          const fitted = fitSceneTextEdit(text, e.target.value);
          if (!fitted) return set({ text: e.target.value });
          set({ text: fitted.text });
          requestAnimationFrame(() => el.setSelectionRange(fitted.caret, fitted.caret));
        }}
        onCompositionEnd={(e) => {
          const el = e.currentTarget;
          if (sceneTextLength(el.value) > MAX_SCENE_TEXT) set({ text: capSceneText(el.value) });
        }}
      />
      {text.trim() && (
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Text position" className={`${inputClass} w-auto`} disabled={disabled} value={overlay?.position ?? "top"} onChange={(e) => set({ position: e.target.value as SceneText["position"] })}>
            {SCENE_TEXT_POSITIONS.map((p) => (
              <option key={p} value={p}>{TEXT_POSITION_LABELS[p]}</option>
            ))}
          </select>
          <select aria-label="Text size" className={`${inputClass} w-auto`} disabled={disabled} value={overlay?.size ?? "medium"} onChange={(e) => set({ size: e.target.value as SceneText["size"] })}>
            {SCENE_TEXT_SIZES.map((sz) => (
              <option key={sz} value={sz}>{TEXT_SIZE_LABELS[sz]}</option>
            ))}
          </select>
          <label className="inline-flex items-center gap-2 text-xs text-slate-600">
            Colour
            <input type="color" aria-label="Text colour" disabled={disabled} value={overlay?.color ?? "#ffffff"} onChange={(e) => set({ color: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-slate-200 bg-white p-0.5" />
          </label>
        </div>
      )}
      {shown && (
        <div id={`${id}-notes`} className="space-y-1 text-xs">
          <p className="text-slate-500">{graphemes(shown).length}/{MAX_SCENE_TEXT} characters, shown on one line</p>
          <p className="text-slate-500">Shown in the preview and kept with the scene. HeyGen&apos;s current API has no text element, so the rendered video does not carry it yet.</p>
          {!sceneTextFits({ ...overlay, text: shown }, aspect) && (
            <p role="alert" className="font-medium text-amber-700">Too long for one line across a {aspect} frame at this size: shorten it or choose a smaller size, or it runs off the edges.</p>
          )}
          {captionsAt && position === captionsAt && (
            <p className="text-amber-700">Captions sit at the {captionsAt} too and may cover this text; move one of them.</p>
          )}
        </div>
      )}
    </div>
  );
}
