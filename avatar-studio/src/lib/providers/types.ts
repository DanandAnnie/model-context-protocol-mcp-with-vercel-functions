import type { Avatar, Translation, Video, VideoRequest, Voice } from "../types";

export interface TtsProvider {
  readonly name: string;
  listVoices(): Promise<Voice[]>;
  /**
   * Synthesize speech. Returns null when the provider cannot produce audio
   * server-side (demo mode); the client then falls back to browser TTS.
   */
  synthesize(voiceId: string, text: string, speed: number): Promise<{ audio: Uint8Array; mimeType: string } | null>;
}

export interface AvatarJobStatus {
  status: Video["status"];
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  error?: string;
}

export interface AvatarProvider {
  readonly name: string;
  listAvatars(): Promise<Avatar[]>;
  /**
   * Make a custom (uploaded) avatar usable by this provider, e.g. by uploading
   * the portrait. Returns the avatar with `providerAssetIds[provider]` set, or
   * the same avatar when nothing is needed. The caller persists the result.
   */
  prepareAvatar?(avatar: Avatar): Promise<Avatar>;
  /** Kick off a render. Returns the provider's job id. */
  createVideo(req: VideoRequest, avatar: Avatar, voice: Voice | null): Promise<{ providerJobId: string }>;
  getStatus(providerJobId: string): Promise<AvatarJobStatus>;
  /** Parse an inbound webhook body into a job update, or null if unrecognised. */
  parseWebhook?(body: unknown): { providerJobId: string; update: AvatarJobStatus } | null;
}

export type ScriptAction = "shorten" | "expand" | "tone" | "translate" | "polish";

export interface ScriptProvider {
  readonly name: string;
  generate(input: { topic: string; tone: string; lengthSec: number; language: string; audience?: string }): Promise<string>;
  /** Transform an existing script: shorten, expand, change tone, translate, or polish. */
  revise(input: { script: string; action: ScriptAction; tone?: string; language?: string }): Promise<string>;
}

export interface TranslateProvider {
  readonly name: string;
  createTranslation(input: { sourceVideoUrl: string; targetLanguage: string; title: string }): Promise<{ providerJobId: string }>;
  getStatus(providerJobId: string): Promise<Pick<Translation, "status" | "videoUrl" | "error">>;
  supportedLanguages(): string[];
  parseWebhook?(body: unknown): { providerJobId: string; update: Pick<Translation, "status" | "videoUrl" | "error"> } | null;
}
