import type { LookPackAspect, LookPackKey } from "./look-packs";
import { graphemes } from "./text";
// Shared domain types for Avatar Studio.

export type AspectRatio = "16:9" | "9:16" | "1:1";

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

/** Output quality; the short side of the frame in pixels. */
export type Resolution = "720p" | "1080p";
/** Where the brand logo sits over the share and embed player; absent means no watermark. */
export const WATERMARK_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type WatermarkCorner = (typeof WATERMARK_CORNERS)[number];
export const RESOLUTIONS: Resolution[] = ["720p", "1080p"];

/** Pixel dimensions for an aspect ratio at a given quality (1080p when omitted). */
export function dimensionsFor(aspect: AspectRatio, resolution: Resolution = "1080p"): { width: number; height: number } {
  const full = ASPECT_DIMENSIONS[aspect];
  if (resolution === "1080p") return full;
  const scale = 720 / 1080;
  return { width: Math.round(full.width * scale), height: Math.round(full.height * scale) };
}

export type AvatarSource = "stock" | "custom" | "provider";

/** Upper bound on scenes per video, shared by the editor and the request schema. */
export const MAX_SCENES = 20;

export interface Avatar {
  id: string;
  name: string;
  /** Thumbnail / portrait. May be an https URL, a data URL, or an inline SVG data URI. */
  imageUrl: string;
  /** Optional short preview clip from the provider. */
  previewVideoUrl?: string;
  source: AvatarSource;
  /** Provider that owns this avatar id (heygen | did | mock). */
  provider: string;
  gender?: "male" | "female" | "neutral";
  /** Voice the editor switches to when this photo avatar is picked; must be available to the owner. */
  defaultVoiceId?: string;
  tags?: string[];
  /** The look can render on HeyGen's Avatar V engine (its `supported_api_engines`); see `AvatarEngine`. */
  avatarV?: true;
  /** Ids assigned by rendering providers after uploading a custom portrait, keyed by provider name. */
  providerAssetIds?: Record<string, string>;
  /** Workspace that owns this avatar (user id with accounts, "local" otherwise). */
  ownerId?: string;
  createdAt?: string;
}

/** A presenter being drawn from a description, kept so only the account that asked can follow it. */
export interface PortraitJob {
  id: string;
  ownerId: string;
  /** Renderer drawing it, and its job id there (HeyGen's look id), never shown to the account. */
  provider: string;
  providerJobId: string;
  status: "processing" | "completed" | "failed";
  /** The finished portrait as a data URL, kept so following it again downloads nothing. */
  imageUrl?: string;
  error?: string;
  createdAt: string;
}

/** Lengths a highlight clip can be cut to, in seconds (HeyGen AI Clipping's `duration_types`). */
export const HIGHLIGHT_LENGTHS = ["30", "60", "180"] as const;
export type HighlightLength = (typeof HIGHLIGHT_LENGTHS)[number];
/** How the clips are framed: 9:16, 16:9, or 1:1 (HeyGen's `portrait`, `landscape`, `square`). */
export const HIGHLIGHT_FRAMES = ["9:16", "16:9", "1:1"] as const;
export type HighlightFrame = (typeof HIGHLIGHT_FRAMES)[number];

/** One short clip cut from a video. Its links are signed by the renderer and refreshed when they get old. */
export interface HighlightClip {
  id: string;
  status: "pending" | "completed" | "failed";
  title?: string;
  durationSec?: number;
  /** The renderer's guess at how well it would do on social media, 0 to 100. */
  viralityScore?: number;
  thumbnailUrl?: string;
  videoUrl?: string;
}

/** A request to cut a finished video into short highlight clips (HeyGen AI Clipping), kept with the video. */
export interface HighlightJob {
  id: string;
  ownerId: string;
  videoId: string;
  /** Renderer cutting it, and its job id there, never shown to the account. */
  provider: string;
  providerJobId: string;
  status: "processing" | "completed" | "failed";
  lengths: HighlightLength[];
  frame: HighlightFrame;
  captions: boolean;
  /** What to look for ("the moments about pricing"); absent lets the renderer choose. */
  prompt?: string;
  /** Rough progress, 0 to 100, while it runs. */
  progress?: number;
  clips: HighlightClip[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** When the renderer was last asked, so finished clips' signed links are renewed before they expire. */
  checkedAt?: string;
}

/** A recording cleaned of filler words ("um", "uh") and overlong silences by the renderer (HeyGen filler word removal). */
export interface CleanupJob {
  id: string;
  ownerId: string;
  title: string;
  /** What was cleaned: one of the account's videos, or a public https link. */
  videoId?: string;
  sourceUrl?: string;
  /** Renderer cleaning it, and its job id there, never shown to the account. */
  provider: string;
  providerJobId: string;
  status: "processing" | "completed" | "failed";
  progress?: number;
  /** The cleaned cut, signed by the renderer for a limited time and renewed when it gets old. */
  videoUrl?: string;
  thumbnailUrl?: string;
  originalSec?: number;
  outputSec?: number;
  /** Filler words cut (silences trimmed are not counted). */
  cuts?: number;
  /** How much shorter the cleaned cut is, in percent. */
  reductionPct?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  checkedAt?: string;
}

/** One look of a look pack: generated by the renderer, then kept as a photo avatar of the account once it is ready. */
export interface LookPackLook {
  status: "processing" | "completed" | "failed";
  /** The photo avatar made of it once it is ready. */
  avatarId?: string;
  error?: string;
}

/** A set of new looks generated for one of the account's photo avatars (HeyGen Look Packs). */
export interface LookPackJob {
  id: string;
  ownerId: string;
  /** The photo avatar the looks were made from, and its name then (the looks are named after it). */
  avatarId: string;
  avatarName: string;
  pack: LookPackKey;
  gender: "female" | "male";
  aspect: LookPackAspect;
  /** Renderer generating them, and each look's id there, never shown to the account. */
  provider: string;
  lookIds: string[];
  looks: LookPackLook[];
  status: "processing" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  checkedAt?: string;
}

/**
 * A digital twin being trained from footage of a real person (HeyGen digital twin): the renderer trains a look from the
 * footage, and the person in it must record their consent on the renderer's page before the twin may render.
 */
export interface TwinJob {
  id: string;
  ownerId: string;
  name: string;
  gender?: "female" | "male";
  /** The footage: a public https link to a video of the person speaking to camera. */
  footageUrl: string;
  /**
   * Renderer training it, its look and character there, and the voice it cloned from the footage, never shown to the
   * account. The look and character are empty while the start is being sent (the row is kept first, so a lost answer
   * is asked for again with the same key).
   */
  provider: string;
  lookId: string;
  groupId: string;
  voiceId?: string;
  /** When a start whose answer was lost was last asked for again (at most every few minutes). */
  resentAt?: string;
  training: "processing" | "completed" | "failed";
  /** Where the person's consent stands: not asked yet, asked (a link sent, or under review), given, or refused. */
  consent: "not_requested" | "pending" | "accepted" | "rejected";
  /** The renderer's page for the person to record consent on, and when it was made (it lasts a day). */
  consentUrl?: string;
  consentUrlAt?: string;
  /** The twin's picture once trained, kept for the photo avatar it becomes. */
  imageUrl?: string;
  /** The photo avatar the twin became once trained and consented to. */
  avatarId?: string;
  status: "processing" | "completed" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
  checkedAt?: string;
}

/**
 * A look the studio made in the renderer's shared account (a photo avatar, a drawn presenter, a look of a pack). Kept
 * after the avatar, portrait, or account that made it is deleted, so the renderer's listing never offers it to anyone.
 */
export interface MadeLook {
  id: string;
  lookId: string;
}

/** A voice the renderer cloned for an account here (a digital twin's), kept as made looks are (see `MadeLook`). */
export interface MadeVoice {
  id: string;
  voiceId: string;
}

/** How closely a lip sync redraws the mouth: fast, or slower and truer to the face (HeyGen avatar inference). */
export const LIPSYNC_MODES = ["speed", "precision"] as const;
export type LipsyncMode = (typeof LIPSYNC_MODES)[number];

/** A video given a new audio track, its speaker's mouth redrawn to match (HeyGen lip sync). */
export interface LipsyncJob {
  id: string;
  ownerId: string;
  title: string;
  /** The footage: one of the account's videos, or a public https link. */
  videoId?: string;
  sourceUrl?: string;
  /** The new audio: one of the account's audio clips, or a public https link. */
  clipId?: string;
  audioUrl?: string;
  mode: LipsyncMode;
  /** Renderer syncing it, and its job id there, never shown to the account. */
  provider: string;
  providerJobId: string;
  status: "processing" | "completed" | "failed";
  /** The lip-synced video, signed by the renderer for a limited time and renewed when it gets old. */
  videoUrl?: string;
  durationSec?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  checkedAt?: string;
}

export interface Voice {
  id: string;
  name: string;
  provider: string;
  language?: string;
  gender?: "male" | "female" | "neutral";
  previewUrl?: string;
  tags?: string[];
  /** The voice can speak its language in another accent (HeyGen's `support_locale`); see `VOICE_ACCENTS`. */
  accents?: true;
  /** "custom" for a cloned voice owned by an account; absent for provider voices. */
  source?: "provider" | "custom";
  ownerId?: string;
  createdAt?: string;
}

export type VideoStatus = "queued" | "processing" | "completed" | "failed";

/** A reusable starting point saved by the account: scenes, presenter, and settings, no render. */
export interface VideoTemplate {
  id: string;
  ownerId?: string;
  title: string;
  description?: string;
  scenes: Scene[];
  avatarId?: string;
  voiceId?: string;
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
  transparent?: true;
  /** The video it was saved from, when it was. */
  sourceVideoId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What sits behind the presenter: a hex colour, a public image URL, or a public video URL that
 * loops behind the presenter (HeyGen plays it; other renderers fall back to their default).
 */
export interface Background {
  type: "color" | "image" | "video";
  value: string;
  /**
   * How an image or video fills the frame: `cover` crops it to fill the frame (the default, stored as absent) and
   * `contain` shows all of it, leaving the rest of the frame plain. HeyGen applies it; other renderers show their
   * default background, so it does nothing there.
   */
  fit?: BackgroundFit;
}

export const BACKGROUND_FITS = ["cover", "contain"] as const;
export type BackgroundFit = (typeof BACKGROUND_FITS)[number];

/**
 * How the presenter is framed: the whole presenter, a close-up of the head and shoulders, or a circle
 * cut-out over the background (HeyGen's avatar styles; a photo avatar has no close-up and shows its full frame).
 */
export const PRESENTER_FRAMINGS = ["full", "closeUp", "circle"] as const;
export type PresenterFraming = (typeof PRESENTER_FRAMINGS)[number];

/** Where the presenter sits in the frame: `scale` 0.5–1.5 (1 is the renderer's default size), `x` and `y` offsets of -1..1 as a share of the frame (0 is the default spot), and the framing (full when absent). */
export interface SceneLayout {
  scale: number;
  x: number;
  y: number;
  framing?: PresenterFraming;
}

/** A presenter made from a photo (an uploaded portrait or a provider photo avatar): HeyGen frames it square or in a circle, never close up. */
export const isPhotoAvatar = (a: { source?: string; tags?: string[] }) => a.source === "custom" || !!a.tags?.includes("photo avatar");
/**
 * Whether a scene's presenter renders on Avatar V when the video asks for it: its look supports the engine, and it is
 * not a photo avatar given expressiveness or gestures. Avatar V rejects expressiveness outright, and a motion prompt
 * for a photo avatar it renders without a reference look, which the request cannot know, so those stay on Avatar IV.
 */
export const rendersOnAvatarV = (a: { source?: string; tags?: string[]; avatarV?: true }, req: { expressiveness?: string; motionPrompt?: string }) =>
  !!a.avatarV && !(isPhotoAvatar(a) && (req.expressiveness || req.motionPrompt));

/** The framing a presenter actually gets: a photo avatar's close-up shows its full frame. */
export const framingFor = (framing: PresenterFraming | undefined, avatar?: { source?: string; tags?: string[] }): PresenterFraming =>
  framing === "closeUp" && avatar && isPhotoAvatar(avatar) ? "full" : (framing ?? "full");

/** True when a layout is the renderer's default and need not be stored. */
export const isDefaultLayout = (l: SceneLayout) => l.scale === 1 && l.x === 0 && l.y === 0 && (l.framing ?? "full") === "full";

export const DEFAULT_LAYOUT: SceneLayout = { scale: 1, x: 0, y: 0 };

/** Where a scene's on-screen text sits, and how large it is. */
export const SCENE_TEXT_POSITIONS = ["top", "center", "bottom"] as const;
export type SceneTextPosition = (typeof SCENE_TEXT_POSITIONS)[number];
export const SCENE_TEXT_SIZES = ["small", "medium", "large"] as const;
export type SceneTextSize = (typeof SCENE_TEXT_SIZES)[number];
/** Where on-screen text sits, as a share of the frame's height (the middle of the line); the stage and HeyGen share it. */
export const SCENE_TEXT_Y: Record<SceneTextPosition, number> = { top: 0.12, center: 0.5, bottom: 0.82 };
/** Text height as a share of the frame's shorter side, so a portrait video gets the same size of text as a wide one. */
export const SCENE_TEXT_SCALE: Record<SceneTextSize, number> = { small: 0.045, medium: 0.065, large: 0.09 };
/** Characters of bold Arial per em, on average: a little wide, so a line judged to fit does. */
const TEXT_EM_PER_CHAR = 0.62;
/**
 * Whether a scene's text fits on one line across 90% of the frame. The renderer draws one line and does not wrap it,
 * so text that does not fit runs off the frame; the editor warns before that happens.
 */
export function sceneTextFits(overlay: SceneText, aspect: AspectRatio): boolean {
  const { width, height } = ASPECT_DIMENSIONS[aspect];
  const fontPx = Math.min(width, height) * SCENE_TEXT_SCALE[overlay.size ?? "medium"];
  return graphemes(overlay.text.replace(/\s+/g, " ").trim()).length * TEXT_EM_PER_CHAR * fontPx <= width * 0.9;
}
/** Longest on-screen text a scene shows: a title or a lower third, not a paragraph. */
export const MAX_SCENE_TEXT = 120;

/**
 * Text shown on screen for the whole scene, as HeyGen's text elements: a title, a name and role, a price.
 * The defaults (top, medium, white) are stored as absent.
 */
export interface SceneText {
  text: string;
  position?: SceneTextPosition;
  size?: SceneTextSize;
  /** `#rrggbb`; white when absent. */
  color?: string;
}

export interface Scene {
  /** Spoken text for this scene. */
  script: string;
  background: Background;
  /** Presenter size and position for this scene; the renderer's default when absent. */
  layout?: SceneLayout;
  /** Text shown on screen for this scene; none when absent. */
  overlay?: SceneText;
  /**
   * The scene shows its picture or video background over the whole frame, with no presenter: narrated by the voice
   * (or a clip), or silent. Only a scene with an image or video background can hide the presenter.
   */
  hidePresenter?: true;
  /** Presenter for this scene; the video's avatar when absent. */
  avatarId?: string;
  /** Voice for this scene; the video's voice when absent. Ignored when the scene uses an audio clip. */
  voiceId?: string;
  /** Speaking speed for this scene (0.5–1.5); the video's when absent. Ignored when the scene uses an audio clip. */
  speed?: number;
  /**
   * Recorded or uploaded audio the presenter lip-syncs to instead of speaking `script` with a voice.
   * `script` then holds what is said, for captions and search.
   */
  audioId?: string;
  /** Display names filled in when the video is created. */
  avatarName?: string;
  voiceName?: string;
  /** The clip's name and length, filled in when the video is created. */
  audioName?: string;
  audioSeconds?: number;
}

/** An uploaded background image; the bytes are stored separately and served to the owner by `/api/backdrops/:id`. */
export interface Backdrop {
  id: string;
  ownerId?: string;
  name: string;
  mimeType: BackdropType;
  bytes: number;
  /** Provider-side asset ids (HeyGen image asset), cached after the first render. Never returned by the API. */
  providerAssetIds?: Record<string, string>;
  createdAt: string;
}

export type BackdropType = "image/png" | "image/jpeg";

/** Uploaded background images an account keeps. */
export const MAX_BACKDROPS = 100;
/** How much of an attached document the Video Agent reads (its text, after it is read in the browser). */
export const MAX_DOCUMENT_CHARS = 12_000;

/** The path an image background takes when it is an uploaded backdrop, and the editor's preview URL for it. */
export const backdropPath = (id: string) => `/api/backdrops/${id}`;

/** The backdrop an image background names, or null for a background given by URL. */
export function backdropIdOf(background: Pick<Background, "type" | "value"> | undefined): string | null {
  if (!background || background.type !== "image") return null;
  return /^\/api\/backdrops\/(bd_[A-Za-z0-9]+)$/.exec(background.value)?.[1] ?? null;
}

export type AudioClipType = "audio/wav" | "audio/mpeg";

/**
 * Longest audio clip, in seconds. A clip is uploaded in one request, and Vercel Functions take at most
 * 4.5 MB per request body: 90 seconds of the editor's 16 kHz mono WAV is 2.9 MB, 3.8 MB as base64 JSON.
 */
export const MAX_CLIP_SECONDS = 90;

/** Audio a scene can use instead of a voice; the bytes are stored separately and served by `/api/clips/:id`. */
export interface AudioClip {
  id: string;
  ownerId?: string;
  name: string;
  mimeType: AudioClipType;
  bytes: number;
  durationSec: number;
  /** Provider-side upload ids (HeyGen asset id, D-ID audio URL), cached after the first render. Never returned by the API. */
  providerAssetIds?: Record<string, string>;
  createdAt: string;
}

export interface VideoRequest {
  /** A key the renderer is asked with, so a request repeated after a lost answer starts nothing twice. Never stored. */
  idempotencyKey?: string;
  title: string;
  /** Full spoken script. When `scenes` is present this is their scripts joined in order. */
  script: string;
  /** Optional per-scene breakdown; providers that support multiple inputs render one per scene. */
  scenes?: Scene[];
  avatarId: string;
  voiceId: string;
  aspect: AspectRatio;
  /** Output quality; videos saved before this option exists have none and rendered at 1080p. */
  resolution?: Resolution;
  background: Background;
  captions: boolean;
  /** How captions look on the share page and in the WebVTT file; the default style when absent. */
  captionStyle?: CaptionStyle;
  /** 0.5 - 1.5 speaking rate multiplier. */
  speed: number;
  /** Voice pitch shift from -50 to 50 (HeyGen; other renderers use the voice's natural pitch); absent means none. */
  pitch?: number;
  /** Speaking style for voices that support one (HeyGen); absent means the voice's natural delivery. */
  emotion?: VoiceEmotion;
  /**
   * How much a photo avatar moves its face as it speaks (HeyGen's Avatar IV); absent means HeyGen's default, low.
   * Applies to scenes whose presenter is a photo avatar; other presenters and renderers ignore it.
   */
  expressiveness?: PhotoExpressiveness;
  /** Body motion and gestures in words (HeyGen's motion prompt), for photo avatars and video avatars on Avatar V; absent means none. */
  motionPrompt?: string;
  /**
   * The accent the voice speaks in, for voices that offer several (HeyGen's `voice_settings.locale`); absent means the
   * voice's own. Applies to scenes whose voice has `accents` and speaks the accent's language; others ignore it.
   */
  accent?: VoiceAccent;
  /**
   * HeyGen's avatar engine: "avatar_v" asks for its higher-quality Avatar V on every scene whose presenter's look
   * supports it (`avatarV`); absent is HeyGen's default, Avatar IV. Other renderers ignore it.
   */
  avatarEngine?: AvatarEngine;
  /**
   * Render the presenter alone over a transparent background, as a WebM with an alpha channel for compositing
   * (HeyGen's `output_format: "webm"`). One scene showing the presenter only; its background is left out, and the
   * avatar must be trained with matting. Absent is a normal video.
   */
  transparent?: true;
  /**
   * Rendered from a HeyGen Studio template rather than composed here: the template and the variables it was filled
   * with. The template owns the layout, presenter, and voice; `script`, `avatarId`, and `voiceId` only describe it.
   */
  studioTemplate?: StudioTemplateUse;
}

/** A filled-in variable of a HeyGen Studio template, in HeyGen's own shape. */
export type StudioAsset = { type: "url"; url: string } | { type: "asset_id"; asset_id: string };
export type StudioVariable =
  | { type: "text"; content: string }
  | { type: "image"; asset?: StudioAsset; fit?: "cover" | "contain" | "crop" | "none" }
  | { type: "video"; asset?: StudioAsset; fit?: "cover" | "contain" | "crop" | "none"; play_style?: string; volume?: number }
  | { type: "audio"; asset?: StudioAsset }
  | { type: "voice"; voice_id: string; locale?: string }
  | { type: "character"; avatar_id: string };
export const STUDIO_VARIABLE_TYPES = ["text", "image", "video", "audio", "voice", "character"] as const;

/** A HeyGen Studio template the account's renderer offers (an "API-ready" template made in HeyGen Studio). */
export interface StudioTemplate {
  id: string;
  name: string;
  thumbnailUrl?: string;
  aspect?: string;
}

/** A template with its variables (their current defaults) and its scenes' scripts, `{{name}}` left in. */
export interface StudioTemplateDetail extends StudioTemplate {
  variables: Record<string, StudioVariable>;
  scenes: Array<{ id: string; script: string; variables: string[] }>;
}

/** The template a video was rendered from and the values sent. */
export interface StudioTemplateUse {
  id: string;
  name: string;
  variables: Record<string, StudioVariable>;
}

/** HeyGen's avatar engines a video can choose; "avatar_iv" is its default and is stored as absent. */
export const AVATAR_ENGINES = ["avatar_iv", "avatar_v"] as const;
export type AvatarEngine = (typeof AVATAR_ENGINES)[number];

/** The accents a video can ask a voice for, as BCP 47 tags; each voice is offered those of its own language. */
export const VOICE_ACCENTS = [
  "en-US", "en-GB", "en-AU", "en-CA", "en-IE", "en-IN", "en-NZ", "en-ZA",
  "es-ES", "es-MX", "es-US", "es-AR", "es-CO",
  "fr-FR", "fr-CA", "fr-BE", "fr-CH",
  "de-DE", "de-AT", "de-CH",
  "pt-BR", "pt-PT",
  "it-IT", "nl-NL", "nl-BE",
  "zh-CN", "zh-TW", "zh-HK",
  "ar-SA", "ar-AE", "ar-EG",
  "hi-IN", "ja-JP", "ko-KR",
] as const;
export type VoiceAccent = (typeof VOICE_ACCENTS)[number];

/** HeyGen's expressiveness levels for photo avatars; "low" is its default and is stored as absent. */
export const PHOTO_EXPRESSIVENESS = ["low", "medium", "high"] as const;
export type PhotoExpressiveness = (typeof PHOTO_EXPRESSIVENESS)[number];
/** Longest gesture description a video takes. */
export const MAX_MOTION_PROMPT = 300;

/** HeyGen's voice emotions, in its own spelling, which is what its API takes. */
export const VOICE_EMOTIONS = ["Excited", "Friendly", "Serious", "Soothing", "Broadcaster"] as const;
export type VoiceEmotion = (typeof VOICE_EMOTIONS)[number];

export const CAPTION_POSITIONS = ["bottom", "top"] as const;
export const CAPTION_SIZES = ["small", "medium", "large"] as const;
/** Subtitle looks: white on a dark box, bold on a solid box, yellow on a dark box, and white with a shadow and no box. */
export const CAPTION_LOOKS = ["classic", "bold", "yellow", "minimal"] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];
export type CaptionSize = (typeof CAPTION_SIZES)[number];
export type CaptionLook = (typeof CAPTION_LOOKS)[number];
/** Typefaces the share player can set captions in; "sans" is the player's own and the default. */
export const CAPTION_FONTS = ["sans", "serif", "rounded", "mono"] as const;
export type CaptionFont = (typeof CAPTION_FONTS)[number];
/** Where subtitles sit, how big they read, and how they look: a cue setting in the WebVTT file and classes on the player. */
export interface CaptionStyle {
  position: CaptionPosition;
  size: CaptionSize;
  /** Absent means "classic". */
  look?: CaptionLook;
  /** Absent means "sans". */
  font?: CaptionFont;
}
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { position: "bottom", size: "medium" };
export function isDefaultCaptionStyle(style: CaptionStyle): boolean {
  return style.position === DEFAULT_CAPTION_STYLE.position && style.size === DEFAULT_CAPTION_STYLE.size && (style.look ?? "classic") === "classic" && (style.font ?? "sans") === "sans";
}

export type WatchQuarter = 25 | 50 | 75 | 100;
export type WatchCounts = { q25: number; q50: number; q75: number; q100: number };
export const EMPTY_WATCH: WatchCounts = { q25: 0, q50: 0, q75: 0, q100: 0 };

/** How long a trashed video can be restored before it is deleted for good. */
export const TRASH_RETENTION_DAYS = 30;

/** A viewer who gave an email at a video's share-page gate; one row per address per video. */
export interface VideoLead {
  id: string;
  ownerId: string;
  videoId: string;
  email: string;
  name?: string;
  createdAt: string;
  lastSeenAt: string;
  visits: number;
}

/** One caption line and when it shows, in milliseconds from the start of the video. */
export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Video extends VideoRequest {
  id: string;
  status: VideoStatus;
  ownerId?: string;
  /** Shown under the share-page player and used as the link preview's description; absent when empty. */
  description?: string;
  /** Translated scripts keyed by language name, offered as extra subtitle tracks on the share page. */
  subtitles?: Record<string, string>;
  /** Captions in the script's language as an editor corrected them; absent while they follow the script. */
  captionCues?: CaptionCue[];
  /** Set when the video was produced by a personalized batch; `rowLabel` identifies the row. */
  batchId?: string;
  rowLabel?: string;
  avatarName?: string;
  voiceName?: string;
  /** Library folder name; unfiled when absent. */
  folder?: string;
  /** Id of the failed render this one was retried from. */
  retryOf?: string;
  /** Id of the video this one was made from in another aspect ratio ("Make other sizes"). */
  resizedFrom?: string;
  /** The UTC month (`YYYY-MM`) whose render allowance counted this render; absent when it failed to start or predates counting. */
  countedIn?: string;
  /** Set while the video sits in the trash; it is deleted for good `TRASH_RETENTION_DAYS` later unless restored. */
  deletedAt?: string;
  /** Share page offers a download link when true (off by default). */
  shareDownload?: boolean;
  /** The share page asks for the viewer's email before the player shows; the answers are `VideoLead` rows. */
  shareGate?: boolean;
  /** The share page, its captions, and the beacons answer "not found" while true. */
  shareDisabled?: boolean;
  /** ISO time after which the share link behaves as if switched off (the owner keeps access). */
  shareExpiresAt?: string;
  /** Visitors must enter a password (kept as a salted hash in its own record) before the share page plays. */
  shareLocked?: boolean;
  /** A custom poster image is stored in its own record; `updatedAt` versions its URL, `bytes` is its decoded size. */
  cover?: { updatedAt: string; mimeType: string; bytes: number };
  /** A button under the share-page player: "Book a showing" → https://… */
  shareCta?: { label: string; url: string };
  /** Review and approval in a workspace: an editor asks, an owner approves or asks for changes. */
  review?: VideoReview;
  /** Share page views (completed videos only; one per viewer per window). */
  views?: number;
  lastViewedAt?: string;
  /** Views per UTC calendar day (`YYYY-MM-DD` → count) for the last 90 days, so the page can show views over time. */
  viewsByDay?: Record<string, number>;
  /** How far share-page viewers got: viewers who passed a quarter, half, three quarters, and the end (one per viewer per window). */
  watch?: WatchCounts;
  /** Clicks on the share-page call to action (one per viewer per window). */
  ctaClicks?: number;
  lastCtaClickAt?: string;
  provider: string;
  providerJobId?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TranslationRequest {
  title: string;
  sourceVideoUrl: string;
  targetLanguage: string;
  /** Dub the voice only and leave the mouth as filmed (faster, and fine for a presenter who is often off screen); lip-synced when absent. */
  audioOnly?: boolean;
  /** How many people speak in the source video, so each gets a voice of their own; the provider guesses when absent. */
  speakers?: number;
  /** "precision" takes longer for a more natural dub; the faster "speed" mode when absent. */
  quality?: TranslationQuality;
  /** Leave the source's background music out of the dub. */
  removeMusic?: boolean;
  /** Clean up the speech audio (noise, room echo). */
  enhanceSpeech?: boolean;
  /** Stop once the lines are translated so someone can correct them before the dub is made. */
  proofread?: boolean;
  /** Terms the dub keeps exactly as written (the brand kit's glossary when the dub was asked to keep it). */
  glossary?: string[];
  /** Terms the dub always translates one way, from the brand kit's rules for its language. */
  forcedTranslations?: Array<{ term: string; translation: string }>;
}

/** How a dub is made: quickly, or more slowly for a more natural result. */
export const TRANSLATION_QUALITIES = ["speed", "precision"] as const;
export type TranslationQuality = (typeof TRANSLATION_QUALITIES)[number];

export type ProofreadStage = "preparing" | "ready" | "dubbing";

/** The most speakers a dub can tell apart. */
export const MAX_TRANSLATION_SPEAKERS = 10;

export interface Translation extends TranslationRequest {
  id: string;
  ownerId?: string;
  status: VideoStatus;
  provider: string;
  providerJobId?: string;
  videoUrl?: string;
  /** Subtitle files of the dub in its language, where the provider makes them. */
  captionUrls?: { srt?: string; vtt?: string };
  /** The provider's proofread session for a dub that is proofread first. */
  providerProofreadId?: string;
  /**
   * Where a proofread dub is: its lines being translated, ready to correct, or sent to be dubbed. Absent
   * once the dub itself has started (its `providerJobId` is then set) and for a dub made straight away.
   */
  proofreadStage?: ProofreadStage;
  /** The translated lines, as the provider made them and then as they were corrected. */
  proofreadCues?: CaptionCue[];
  /** Secret in the link the provider reads the corrected lines from. Never sent to the browser or put in an export. */
  proofreadToken?: string;
  /** When the dub of proofread lines was started; the provider may not know the job for a moment after. */
  dubStartedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** A term a translation always renders one way, e.g. { term: "CEO", translation: "Geschäftsführer", language: "German" }. */
export interface ForcedTranslation {
  term: string;
  translation: string;
  /** The language the rule is for; every language when absent. */
  language?: string;
}

/** A word the renderer should say differently, e.g. { word: "Nair", sayAs: "Nye-er" }. */
export interface Pronunciation {
  word: string;
  sayAs: string;
}

/** Per-owner branding applied to new videos and the public share page. */
export interface BrandKit {
  /** `brand_<ownerId>`; one kit per owner. */
  id: string;
  ownerId: string;
  /** Company or product name shown on share pages. */
  name: string;
  /** Logo as an https URL or an uploaded data URL. */
  logoUrl?: string;
  /** Hex colors. Primary becomes the default scene background (unless `defaultBackground` is set) and the share page accent. */
  primaryColor: string;
  accentColor?: string;
  /** An image or video behind every new video's scenes instead of the primary colour. */
  defaultBackground?: Background;
  /** How the renderer says particular words; the stored script and captions keep the spelling. */
  pronunciations?: Pronunciation[];
  /** Terms the AI translation (script Translate, subtitle languages) leaves exactly as written. */
  glossary?: string[];
  /** Terms the AI translation always renders one way: in every language, or only in `language`. */
  forcedTranslations?: ForcedTranslation[];
  defaultAvatarId?: string;
  defaultVoiceId?: string;
  defaultAspect?: AspectRatio;
  defaultResolution?: Resolution;
  captionsByDefault?: boolean;
  /** The logo laid over the share and embed player in this corner (the file itself is not changed). */
  watermark?: WatermarkCorner;
  updatedAt: string;
}

/** Personal API key. The secret is returned once at creation; only `hash` is stored. */
export interface ApiKey {
  id: string;
  ownerId: string;
  name: string;
  /** First characters of the secret, for recognising a key in the list. */
  prefix: string;
  hash: string;
  /** Personal id of the person who minted it (differs from ownerId inside a workspace). */
  createdBy?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export type NotifyEvent = "video.completed" | "video.failed" | "lead.captured" | "test";

/** Outbound webhook: one endpoint per owner, called when a render finishes. */
export interface NotifySettings {
  /** `notify_<ownerId>` */
  id: string;
  ownerId: string;
  url: string;
  /** HMAC-SHA256 signing secret, shown in Settings. */
  secret: string;
  createdAt: string;
  updatedAt: string;
  lastDelivery?: { at: string; event: NotifyEvent; ok: boolean; status?: number; error?: string };
}

/** Per-owner preferences that are not provider settings. */
export interface Prefs {
  /** `prefs_<ownerId>` */
  id: string;
  ownerId: string;
  /** Send an email when a render completes or fails. */
  emailOnComplete?: string;
  /** Starred avatars and voices, listed first in every picker. */
  favoriteAvatarIds?: string[];
  favoriteVoiceIds?: string[];
  updatedAt: string;
}

export type WorkspaceRole = "owner" | "editor" | "viewer";

export interface WorkspaceMember {
  userId: string;
  email?: string;
  role: WorkspaceRole;
  joinedAt: string;
}

/** Stored as its own record (kind "invite") so a link resolves with one lookup. */
export interface WorkspaceInvite {
  /** Secret token in the invite link; doubles as the record id. */
  id: string;
  token: string;
  /** The workspace, stored as ownerId so it can be listed per workspace. */
  ownerId: string;
  email?: string;
  role: WorkspaceRole;
  createdAt: string;
  expiresAt: string;
}

/** One per (workspace, user), owned by the user, so "my workspaces" is an indexed list. */
export interface Membership {
  id: string;
  ownerId: string;
  workspaceId: string;
  role: WorkspaceRole;
  joinedAt: string;
}

/** A shared owner id: every video, avatar, brand kit, key, and webhook created while it is active belongs to it. */
export interface Workspace {
  id: string;
  name: string;
  createdBy: string;
  /** Authoritative member list (small); memberships mirror it for per-user listing. */
  members: WorkspaceMember[];
  createdAt: string;
  updatedAt: string;
}

/** A saved interactive presenter that visitors can talk to on a public page. */
export interface Agent {
  id: string;
  ownerId: string;
  name: string;
  avatarId: string;
  voiceId?: string;
  /** Snapshot of the presenter so public pages and turns need no provider call. */
  avatarName: string;
  avatarImageUrl: string;
  voiceLanguage?: string;
  instructions: string;
  /** Opening line shown as the presenter's first message on the talk page (and sent with the transcript). */
  greeting?: string;
  /** Up to three suggested questions offered as chips before the visitor's first message. */
  starters?: string[];
  /** A public web page whose readable text is kept as reference material for replies; never shown to visitors. */
  knowledgeUrl?: string;
  knowledge?: string;
  knowledgeUpdatedAt?: string;
  language: string;
  /** Visitors can open /talk/:id without signing in. */
  isPublic: boolean;
  /** Ask visitors for an email after the first reply. */
  collectEmail?: boolean;
  /** Visitor conversations started (first message of a session). */
  conversations: number;
  messages: number;
  createdAt: string;
  updatedAt: string;
}

/** A visitor's conversation with a shared presenter, kept for the owner. */
export interface Conversation {
  id: string;
  /** The agent's owner, so transcripts list with the owner index. */
  ownerId: string;
  agentId: string;
  messages: Array<{ role: "user" | "assistant"; content: string; at: string }>;
  /** Contact details the visitor chose to leave. */
  visitor?: { email: string; name?: string };
  startedAt: string;
  updatedAt: string;
}

/** A note left on a video by someone with access to it (the owner, or a workspace member). */
export interface VideoComment {
  id: string;
  /** The video's owner (person or workspace), so comments list with the owner index. */
  ownerId: string;
  videoId: string;
  /** The person who wrote it; their email when the account mode knows one. */
  authorId: string;
  authorEmail?: string;
  text: string;
  /** The moment in the video the note is about, in seconds from the start (tenths kept); absent for a note on the whole video. */
  atSec?: number;
  /** Workspace members named as `@email` in the text; each is emailed a link to the video once. */
  mentions?: Array<{ userId: string; email: string }>;
  createdAt: string;
}

/** Where a workspace video stands in review: awaiting an owner, approved, or sent back with changes. */
export type ReviewStatus = "pending" | "approved" | "changes";

export const REVIEW_LABEL: Record<ReviewStatus, string> = { pending: "In review", approved: "Approved", changes: "Changes requested" };

export interface VideoReview {
  status: ReviewStatus;
  /** Who asked for the review, by user id (and email when known). */
  requestedById: string;
  requestedByEmail?: string;
  requestedAt: string;
  /** The request's note, or the owner's reason when asking for changes. */
  note?: string;
  decidedById?: string;
  decidedByEmail?: string;
  decidedAt?: string;
}

/** What happened in an account or workspace, for its activity feed. */
export type ActivityKind =
  | "video.created"
  | "video.trashed"
  | "video.restored"
  | "video.purged"
  | "batch.created"
  | "member.joined"
  | "member.left"
  | "member.removed"
  | "member.role"
  | "apikey.created"
  | "apikey.revoked"
  | "brand.saved"
  | "brand.removed"
  | "agent.created"
  | "agent.deleted"
  | "video.review_requested"
  | "video.approved"
  | "video.changes_requested";

export interface ActivityEvent {
  id: string;
  /** The account or workspace the event belongs to. */
  ownerId: string;
  kind: ActivityKind;
  /** The person who did it; the owner id itself when a script with an API key did. */
  actorId: string;
  actorEmail?: string;
  /** What it was done to: a video title, a member's email, a key or presenter name. */
  subject?: string;
  subjectId?: string;
  /** For bulk actions, how many items. */
  count?: number;
  /** For a role change, the new role. */
  role?: string;
  createdAt: string;
}

export type PlanId = "free" | "pro";

/** Billing plan of an owner (person or workspace). Absent means free. */
export interface Plan {
  /** `plan_<ownerId>` */
  id: string;
  ownerId: string;
  plan: PlanId;
  /** Billing provider state, when a paid subscription backs the plan. */
  provider?: string;
  customerId?: string;
  subscriptionId?: string;
  status?: string;
  /** When the current paid period ends, if the subscription has been cancelled. */
  endsAt?: string;
  updatedAt: string;
}

export interface ProviderStatus {
  mode: "demo" | "live";
  avatar: string;
  tts: string;
  script: string;
  translate: string;
  persistence: "memory" | "supabase";
  /** Invite email backend: "resend" or "mock" (links only). */
  email: string;
  authEnabled: boolean;
  authMode: "open" | "password" | "supabase";
  /** Renders allowed for the current owner per calendar month, or null when unlimited. */
  renderLimitPerMonth: number | null;
  /** Billing backend: "stripe" or "mock" (instant upgrades for demos). */
  billing: string;
  /** Live video for the interactive avatar: "liveavatar" or "mock" (portrait only). */
  streaming: string;
  /** Whether the voice provider can clone a voice from samples. */
  voiceCloning: boolean;
  /** The voice provider clones from one WAV or MP3 recording (HeyGen): the page joins the samples into one WAV first. */
  voiceCloneOneRecording?: true;
  /** Whether the renderer can draw a presenter from a description. */
  portraitGeneration: boolean;
  /** Whether the renderer can cut a finished video into short highlight clips. */
  highlightClips: boolean;
  /** Whether the renderer can clean filler words and long silences out of a recording. */
  fillerRemoval: boolean;
  /** Whether the renderer can put a new audio track on a video and redraw the mouth to match. */
  lipsync: boolean;
  /** Whether the renderer can generate a pack of new looks for a photo avatar. */
  lookPacks: boolean;
  /** Whether the renderer can train a digital twin from footage. */
  digitalTwins: boolean;
  /** Whether the renderer offers HeyGen Studio templates to fill and render. */
  studioTemplates: boolean;
  /** Whether the TTS provider can design a voice from a description. */
  voiceDesign: boolean;
  /** Present when the request carried an owner (signed in, or open/password mode). */
  usage?: { rendersThisMonth: number; plan: PlanId; proRendersPerMonth: number | null; proPriceLabel: string; subscriptionStatus?: string; endsAt?: string; billingAccount?: boolean };
}
