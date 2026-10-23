// Shared domain types for Avatar Studio.

export type AspectRatio = "16:9" | "9:16" | "1:1";

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

export type AvatarSource = "stock" | "custom" | "provider";

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

export interface VideoRequest {
  title: string;
  script: string;
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
  avatarName?: string;
  voiceName?: string;
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
  status: VideoStatus;
  provider: string;
  providerJobId?: string;
  videoUrl?: string;
  error?: string;
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
}
