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
  speed: number;
  /** The video it was saved from, when it was. */
  sourceVideoId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Background {
  type: "color" | "image";
  value: string;
}

export interface Scene {
  /** Spoken text for this scene. */
  script: string;
  background: Background;
  /** Presenter for this scene; the video's avatar when absent. */
  avatarId?: string;
  /** Voice for this scene; the video's voice when absent. */
  voiceId?: string;
  /** Display names filled in when the video is created. */
  avatarName?: string;
  voiceName?: string;
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
  /** 0.5 - 1.5 speaking rate multiplier. */
  speed: number;
}

export interface Video extends VideoRequest {
  id: string;
  status: VideoStatus;
  ownerId?: string;
  /** Set when the video was produced by a personalized batch; `rowLabel` identifies the row. */
  batchId?: string;
  rowLabel?: string;
  avatarName?: string;
  voiceName?: string;
  /** Library folder name; unfiled when absent. */
  folder?: string;
  /** Id of the failed render this one was retried from. */
  retryOf?: string;
  /** Share page offers a download link when true (off by default). */
  shareDownload?: boolean;
  /** The share page, its captions, and the beacons answer "not found" while true. */
  shareDisabled?: boolean;
  /** A button under the share-page player: "Book a showing" → https://… */
  shareCta?: { label: string; url: string };
  /** Share page views (completed videos only; one per viewer per window). */
  views?: number;
  lastViewedAt?: string;
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

/** Per-owner branding applied to new videos and the public share page. */
export interface BrandKit {
  /** `brand_<ownerId>`; one kit per owner. */
  id: string;
  ownerId: string;
  /** Company or product name shown on share pages. */
  name: string;
  /** Logo as an https URL or an uploaded data URL. */
  logoUrl?: string;
  /** Hex colors. Primary becomes the default scene background and the share page accent. */
  primaryColor: string;
  accentColor?: string;
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
  updatedAt: string;
}

export type WorkspaceRole = "owner" | "editor";

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
