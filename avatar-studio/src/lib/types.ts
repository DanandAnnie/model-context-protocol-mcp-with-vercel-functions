// Shared domain types for Avatar Studio.

export type AspectRatio = "16:9" | "9:16" | "1:1";

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

/** Output quality; the short side of the frame in pixels. */
export type Resolution = "720p" | "1080p";
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
  /** Ids assigned by rendering providers after uploading a custom portrait, keyed by provider name. */
  providerAssetIds?: Record<string, string>;
  /** Workspace that owns this avatar (user id with accounts, "local" otherwise). */
  ownerId?: string;
  createdAt?: string;
}

export interface Voice {
  id: string;
  name: string;
  provider: string;
  language?: string;
  gender?: "male" | "female" | "neutral";
  previewUrl?: string;
  tags?: string[];
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
}

/** Where the presenter sits in the frame: `scale` 0.5–1.5 (1 is the renderer's default size), `x` and `y` offsets of -1..1 as a share of the frame (0 is the default spot). */
export interface SceneLayout {
  scale: number;
  x: number;
  y: number;
}

export const DEFAULT_LAYOUT: SceneLayout = { scale: 1, x: 0, y: 0 };

export interface Scene {
  /** Spoken text for this scene. */
  script: string;
  background: Background;
  /** Presenter size and position for this scene; the renderer's default when absent. */
  layout?: SceneLayout;
  /** Presenter for this scene; the video's avatar when absent. */
  avatarId?: string;
  /** Voice for this scene; the video's voice when absent. Ignored when the scene uses an audio clip. */
  voiceId?: string;
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
}

export const CAPTION_POSITIONS = ["bottom", "top"] as const;
export const CAPTION_SIZES = ["small", "medium", "large"] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];
export type CaptionSize = (typeof CAPTION_SIZES)[number];
/** Where subtitles sit and how big they read: a cue setting in the WebVTT file and a size class on the player. */
export interface CaptionStyle {
  position: CaptionPosition;
  size: CaptionSize;
}
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { position: "bottom", size: "medium" };
export function isDefaultCaptionStyle(style: CaptionStyle): boolean {
  return style.position === DEFAULT_CAPTION_STYLE.position && style.size === DEFAULT_CAPTION_STYLE.size;
}

export type WatchQuarter = 25 | 50 | 75 | 100;
export type WatchCounts = { q25: number; q50: number; q75: number; q100: number };
export const EMPTY_WATCH: WatchCounts = { q25: 0, q50: 0, q75: 0, q100: 0 };

/** How long a trashed video can be restored before it is deleted for good. */
export const TRASH_RETENTION_DAYS = 30;

export interface Video extends VideoRequest {
  id: string;
  status: VideoStatus;
  ownerId?: string;
  /** Shown under the share-page player and used as the link preview's description; absent when empty. */
  description?: string;
  /** Translated scripts keyed by language name, offered as extra subtitle tracks on the share page. */
  subtitles?: Record<string, string>;
  /** Set when the video was produced by a personalized batch; `rowLabel` identifies the row. */
  batchId?: string;
  rowLabel?: string;
  avatarName?: string;
  voiceName?: string;
  /** Library folder name; unfiled when absent. */
  folder?: string;
  /** Id of the failed render this one was retried from. */
  retryOf?: string;
  /** Set while the video sits in the trash; it is deleted for good `TRASH_RETENTION_DAYS` later unless restored. */
  deletedAt?: string;
  /** Share page offers a download link when true (off by default). */
  shareDownload?: boolean;
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
}

export interface Translation extends TranslationRequest {
  id: string;
  ownerId?: string;
  status: VideoStatus;
  provider: string;
  providerJobId?: string;
  videoUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
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
  defaultAvatarId?: string;
  defaultVoiceId?: string;
  defaultAspect?: AspectRatio;
  defaultResolution?: Resolution;
  captionsByDefault?: boolean;
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
  /** Live video for the interactive avatar: "heygen" or "mock" (portrait only). */
  streaming: string;
  /** Whether the voice provider can clone a voice from samples. */
  voiceCloning: boolean;
  /** Present when the request carried an owner (signed in, or open/password mode). */
  usage?: { rendersThisMonth: number; plan: PlanId; proRendersPerMonth: number | null; proPriceLabel: string; subscriptionStatus?: string; endsAt?: string };
}
