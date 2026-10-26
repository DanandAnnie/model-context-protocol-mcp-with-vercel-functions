"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Captions, ChevronLeft, ChevronRight, Clapperboard, Copy, Image as ImageIcon, Layers, Mic2, Palette, Pause, Play, Plus, Sparkles, Square, Trash2, Upload, Users, Wand2, X } from "lucide-react";
import { AvatarGrid } from "@/components/AvatarPicker";
import { VoiceRow } from "@/components/VoicePicker";
import { Button, Card, ErrorBanner, Field, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { ViewOnlyNotice } from "@/components/ViewOnlyNotice";
import { SceneAudio } from "@/components/SceneAudio";
import { BackdropPicker } from "@/components/BackdropPicker";
import { favoritesFirst, useFavorites } from "@/hooks/useFavorites";
import { useVoicePreview } from "@/hooks/useVoicePreview";
import { api, estimateSeconds, formatSeconds, isDarkHex, wordCount } from "@/lib/client";
import { languageLabel } from "@/lib/language";
import { stripPauses } from "@/lib/pauses";
import { MAX_IMPORT_BYTES, MAX_SCRIPT_CHARS, decodeScript, legacyEncodingFor, scenesFromText } from "@/lib/script-import";
import { renderPdf, slideScripts } from "@/lib/pdf-slides";
import { readPptx, type PptxSlide } from "@/lib/pptx-notes";
import { readDocx } from "@/lib/docx-text";
import { portraitSvg } from "@/lib/stock";
import { findTemplate } from "@/lib/templates";
import { takeAgentDraft, type AgentDraft } from "@/lib/agent-draft";
import { CAPTION_FONTS, CAPTION_LOOKS, CAPTION_POSITIONS, CAPTION_SIZES, DEFAULT_CAPTION_STYLE, DEFAULT_LAYOUT, MAX_SCENES, PRESENTER_FRAMINGS, RESOLUTIONS, isDefaultCaptionStyle as isDefaultCaptionStyleFn, MAX_BACKDROPS, backdropIdOf, backdropPath, framingFor, isDefaultLayout, isPhotoAvatar, type PresenterFraming, type AspectRatio, type AudioClip, type Avatar, type Backdrop, type Background, type BrandKit, type CaptionFont, type CaptionLook, type CaptionStyle, type Resolution, type Scene, type SceneLayout, type Video, type VideoTemplate, type Voice, type VoiceEmotion, VOICE_EMOTIONS } from "@/lib/types";

const BG_PRESETS = ["#f1f5f9", "#ffffff", "#0f172a", "#1e3a8a", "#4f46e5", "#065f46", "#7c2d12", "#be123c"];
const DEFAULT_BG: Background = { type: "color", value: "#f1f5f9" };
/** Where the personal space's draft is kept; a workspace's has its id after it (see `draftKeyFor`). */
const DRAFT_KEY = "avatar-studio:draft";

/**
 * Each space keeps its own draft: one started in Personal never shows up, or loses its uploaded images, in a
 * workspace (the images are the space's own). Personal keeps the original key, so drafts saved before survive.
 */
function draftKeyFor(spaces: { personalId: string; activeId: string } | null): string | null {
  return spaces ? (spaces.activeId === spaces.personalId ? DRAFT_KEY : `${DRAFT_KEY}:${spaces.activeId}`) : null;
}

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

/** A deck larger than this is refused before pdf.js reads it. */
const MAX_PDF_BYTES = 50_000_000;
/** A PowerPoint file larger than this is refused before it is unpacked (its pictures and video count, though only its text is read). */
const MAX_PPTX_BYTES = 100_000_000;
const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** A Word file larger than this is refused before it is unpacked (its pictures count, though only its text is read). */
const MAX_DOCX_BYTES = 50_000_000;

/** Whether the scenes hold anything worth asking about before they are replaced: a script, a clip, a presenter, a layout, or more than one scene. */
const setUpScenes = (list: Scene[]) => list.length > 1 || list.some((sc) => sc.script.trim() || sc.audioId || sc.avatarId || sc.voiceId || sc.layout);

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

const newScene = (script = "", background: Background = DEFAULT_BG, presenter: Pick<Scene, "avatarId" | "voiceId" | "layout" | "audioId"> = {}): Scene => ({
  script,
  background,
  ...(presenter.avatarId ? { avatarId: presenter.avatarId } : {}),
  ...(presenter.voiceId && !presenter.audioId ? { voiceId: presenter.voiceId } : {}),
  ...(presenter.layout ? { layout: presenter.layout } : {}),
  ...(presenter.audioId ? { audioId: presenter.audioId } : {}),
});
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
    setScenes(doc.scenes.map((script) => newScene(script, background)));
    setActiveIdx(0);
    if (doc.title && (!title.trim() || title === "Untitled video")) setTitle(doc.title);
    setImportNote(`Imported ${doc.scenes.length === 1 ? "1 scene" : `${doc.scenes.length} scenes`} from ${file.name}${doc.truncated ? `; the rest did not fit (a video holds up to ${MAX_SCENES} scenes and ${MAX_SCRIPT_CHARS} characters of script)` : ""}.`);
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
    setScenes(scripts.map((script, i) => newScene(script, sameCount ? current[i].background : shared)));
    setActiveIdx(0);
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
      setScenes(made.map((b, i) => newScene(scripts[i], { type: "image", value: backdropPath(b.id) })));
      setActiveIdx(0);
      // A format picked while the deck was importing is the user's choice and stays.
      if (aspectNow.current === aspectBefore) setAspect(deckAspect);
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
  // What the scene's presenter will get: a photo avatar has no close-up, so it is previewed and listed in full.
  const framing: PresenterFraming = framingFor(layout.framing, sceneAvatar ?? undefined);
  const photoPresenter = !!sceneAvatar && isPhotoAvatar(sceneAvatar);
  // The layout as it renders, for the panel's summary and its Reset button.
  const shownLayout: SceneLayout = { ...layout, framing };
  const sceneVoice = (active.voiceId && voiceData?.voices.find((v) => v.id === active.voiceId)) || voice;
  // Voices the video speaks with (its own and each spoken scene's), and those HeyGen says take no emotion.
  const spokenVoices = [...new Set(scenes.filter((sc) => !sc.audioId).map((sc) => (sc.voiceId && voiceData?.voices.find((v) => v.id === sc.voiceId)) || voice))].filter((v): v is Voice => !!v);
  const flatVoices = spokenVoices.filter((v) => v.emotionSupport === false).map((v) => v.name);
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
        return { ...sc, background: DEFAULT_BG };
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
  const [pitch, setPitch] = useState(0);
  const [emotion, setEmotion] = useState<VoiceEmotion | "">("");
  const [tab, setTab] = useState<Tab>("avatar");
  const [writerOpen, setWriterOpen] = useState(params.get("writer") === "1");
  const [assistOpen, setAssistOpen] = useState(false);
  const writerButton = useRef<HTMLButtonElement>(null);
  const improveButton = useRef<HTMLButtonElement>(null);
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
  // The draft belongs to the space being worked in, so nothing is restored or saved until that is known.
  const { data: spaces, error: spacesError } = useApi<{ personalId: string; activeId: string }>("/api/workspaces");
  // Unknown (the list failed to load), no draft is restored or saved: guessing Personal would show its draft in a
  // workspace and spoil it there. A template, a copy, or a plan still opens.
  const draftKey = draftKeyFor(spaces);
  const spacesKnown = !!spaces || !!spacesError;
  const templateId = params.get("template");
  const fromId = params.get("from");
  // A Video Agent plan to review (?plan=agent), read once: a refresh comes back to the autosaved draft of it.
  const agentPlan = useRef<AgentDraft | null | undefined>(undefined);
  const [fromAgent, setFromAgent] = useState(false);

  // Restore an unsent draft on a plain visit (not when a template or copy is requested).
  useEffect(() => {
    if (hydrated.current || !spacesKnown) return;
    hydrated.current = true;
    if (templateId || fromId) return;
    if (params.get("plan") === "agent") {
      if (agentPlan.current === undefined) agentPlan.current = takeAgentDraft();
      const p = agentPlan.current;
      if (p) {
        setTitle(p.title);
        setScenes(p.scenes.map((sc) => newScene(sc.script, sc.background, { layout: restoredLayout(sc.layout) })));
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
    if (!draftKey || scenesNow.current.some((sc) => sc.script.trim())) return;
    const d = readDraft(draftKey);
    if (!d) return;
    setTitle(d.title);
    setScenes(d.scenes.map((sc) => newScene(sc.script, sc.background, { ...sc, layout: restoredLayout(sc.layout) })));
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
    setPrefill({ avatarId: d.avatarId, voiceId: d.voiceId });
    setDraftRestored(d.savedAt);
  }, [templateId, fromId, params, draftKey, spacesKnown]);

  // Autosave the editor state (debounced) so a refresh never loses work.
  useEffect(() => {
    if (!hydrated.current || !draftKey) return;
    const empty = scenes.every((sc) => !sc.script.trim()) && title === "Untitled video";
    const t = setTimeout(() => {
      writeDraft(draftKey, empty ? null : { title, scenes, aspect, resolution, captions, ...(isDefaultCaptionStyle ? {} : { captionStyle }), speed, ...(pitch ? { pitch } : {}), ...(emotion ? { emotion } : {}), avatarId: avatar?.id, voiceId: voice?.id, savedAt: new Date().toISOString() });
    }, 400);
    return () => clearTimeout(t);
  }, [title, scenes, aspect, resolution, captions, captionStyle, isDefaultCaptionStyle, speed, pitch, emotion, avatar, voice, draftKey]);

  function discardDraft() {
    if (draftKey) writeDraft(draftKey, null);
    setTitle("Untitled video");
    setScenes([newScene()]);
    setActiveIdx(0);
    setAspect("16:9");
    setResolution("1080p");
    setCaptions(false);
    setSpeed(1);
    setPitch(0);
    setEmotion("");
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
    setScenes((prev) => prev.map((sc) => (sc.script.trim() ? sc : { ...sc, background: b.defaultBackground ?? { type: "color", value: b.primaryColor } })));
  }, [brandData, fromId, templateId, draftRestored, fromAgent]);

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
        setEmotion(template.emotion ?? "");
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
        setEmotion(video.emotion ?? "");
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
  const allScenesFilled = scenes.every((sc) => stripPauses(sc.script).trim().length > 0);
  // The server takes up to 5000 characters of script across all scenes (joined by a blank line).
  const scriptChars = scenes.map((sc) => sc.script.trim()).join("\n\n").length;
  const scriptTooLong = scriptChars > MAX_SCRIPT_CHARS;
  // A template's {placeholders} left in a script would be read out as they are.
  const unfilled = [...new Set(scenes.flatMap((sc) => sc.script.match(/\{[\p{L}_][\p{L}\p{N}_ -]{0,39}\}/gu) ?? []))];
  const canEdit = useCanEdit();
  const canGenerate = canEdit !== false && !!avatar && !!voice && allScenesFilled && !scriptTooLong && title.trim().length > 0 && !submitting;

  async function generate() {
    if (!avatar || !voice) return;
    setSubmitting(true);
    setErr(null);
    try {
      const { video } = await api<{ video: Video }>("/api/videos", {
        method: "POST",
        body: JSON.stringify({ title, scenes, avatarId: avatar.id, voiceId: voice.id, aspect, resolution, captions, ...(captions && !isDefaultCaptionStyle ? { captionStyle } : {}), speed, ...(pitch ? { pitch } : {}), ...(emotion ? { emotion } : {}) }),
      });
      if (draftKey) writeDraft(draftKey, null);
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
          <input className={`${inputClass} text-base font-medium`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Video title" />

          <Card className="overflow-hidden">
            {/* A portrait stage is sized by its height and takes its width from the ratio, so it really is 9:16 (a width-first box capped in height came out near square and cropped portrait slides); the height is also capped by the screen's width, so a narrow phone keeps the shape. */}
            <div data-testid="stage" className={`relative mx-auto ${aspect === "9:16" ? "h-[min(520px,70vh,calc((100vw_-_5rem)*16/9))] max-w-full" : "w-full"} ${stageAspect} flex items-end justify-center overflow-hidden`} style={background.type === "color" ? { background: background.value } : background.type === "image" ? { backgroundImage: `url(${background.value})`, backgroundSize: "cover", backgroundPosition: "center" } : { background: "#0f172a" }}>
              {/* Only a complete URL is previewed, so a half-typed one is not requested keystroke by keystroke. */}
              {background.type === "video" && /^https?:\/\/\S+\.\S+/.test(background.value) && (
                <video key={background.value} src={background.value} muted loop autoPlay playsInline aria-hidden="true" data-testid="stage-video" className="absolute inset-0 h-full w-full object-cover" />
              )}
              {sceneAvatar ? (
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
              {captions && active.script.trim() && (
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
            {importNote && (
              <p role="status" className="-mt-1 mb-3 flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="import-note">
                <span>{importNote}</span>
                <button type="button" onClick={() => setImportNote(null)} aria-label="Dismiss" className="rounded p-0.5 text-slate-400 hover:text-slate-600">
                  <X className="h-3.5 w-3.5" />
                </button>
              </p>
            )}
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
                <span className="text-slate-500">Applies to this scene. HeyGen renders the framing, size, and position (a photo avatar has no close-up); other renderers use their default.</span>
                {!isDefaultLayout(shownLayout) && (
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
                {scriptTooLong && (
                  <span role="alert" className="text-xs font-medium text-rose-600" data-testid="script-too-long">
                    {scriptChars} of {MAX_SCRIPT_CHARS} characters; shorten the script to generate
                  </span>
                )}
                <Button ref={writerButton} variant="secondary" className="px-3 py-1.5" aria-expanded={writerOpen} onClick={() => setWriterOpen((v) => !v)}>
                  <Wand2 className="h-4 w-4" /> Write with AI
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
                    disabled={!active.script.trim()}
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
                    onClick={() => play(sceneVoice, active.script.slice(0, 400).replace(/\[[^\]]*$/, ""), speed).catch((e) => setErr(e.message))}
                  >
                    {playingId === sceneVoice.id ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {playingId === sceneVoice.id ? "Stop" : "Listen"}
                  </Button>
                )}
              </div>
            </div>
            {writerOpen && (
              <ScriptWriter
                onClose={() => {
                  setWriterOpen(false);
                  writerButton.current?.focus();
                }}
                onScript={(s) => { setScript(s); setWriterOpen(false); }}
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
                        onPreview={() => play(v, script.trim().slice(0, 200) || "Hi, this is a preview of my voice.", speed).catch((e) => setErr(e.message))}
                        favorite={favorites.voiceIds.has(v.id)}
                        onToggleFavorite={favorites.canToggle ? () => favorites.toggle("voice", v.id) : undefined}
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
                <BackdropPicker
                  value={background}
                  onChange={setBackground}
                  backdrops={backdropData?.backdrops ?? []}
                  setBackdrops={(update) => setBackdropData((d) => ({ backdrops: update(d?.backdrops ?? []) }))}
                  loadError={backdropError}
                  canEdit={canEdit !== false}
                />
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
                <Field
                  label="Voice emotion"
                  hint={
                    flatVoices.length && flatVoices.length === spokenVoices.length
                      ? `${flatVoices.join(", ")} always ${flatVoices.length === 1 ? "speaks" : "speak"} naturally, so the emotion does not apply to this video.`
                      : flatVoices.length
                      ? `${flatVoices.join(", ")} always ${flatVoices.length === 1 ? "speaks" : "speak"} naturally; the emotion applies to scenes whose voice supports one.`
                      : "HeyGen voices that support it speak in this style; other renderers keep the voice's natural delivery."
                  }
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

