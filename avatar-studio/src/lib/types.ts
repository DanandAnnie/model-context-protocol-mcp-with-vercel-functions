// Shared domain types for Avatar Studio.

export type AspectRatio = "16:9" | "9:16" | "1:1";

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

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
}

export type VideoStatus = "queued" | "processing" | "completed" | "failed";

export interface Background {
  type: "color" | "image";
  value: string;
}

export interface Scene {
  /** Spoken text for this scene. */
  script: string;
  background: Background;
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
  /** Share page views (completed videos only; one per viewer per window). */
  views?: number;
  lastViewedAt?: string;
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

export type NotifyEvent = "video.completed" | "video.failed" | "test";

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

export type WorkspaceRole = "owner" | "editor";

export interface WorkspaceMember {
  userId: string;
  email?: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspaceInvite {
  /** Secret token in the invite link. */
  token: string;
  email?: string;
  role: WorkspaceRole;
  createdAt: string;
  expiresAt: string;
}

/** A shared owner id: every video, avatar, brand kit, key, and webhook created while it is active belongs to it. */
export interface Workspace {
  id: string;
  name: string;
  createdBy: string;
  members: WorkspaceMember[];
  invites: WorkspaceInvite[];
  createdAt: string;
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
  /** Renders allowed per owner per calendar month, or null when unlimited. */
  renderLimitPerMonth: number | null;
  /** Present when the request carried an owner (signed in, or open/password mode). */
  usage?: { rendersThisMonth: number };
}
