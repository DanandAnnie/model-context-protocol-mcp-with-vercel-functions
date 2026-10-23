import type { Avatar, Translation, Video, VideoRequest, Voice } from "../types";

export interface TtsProvider {
  readonly name: string;
  listVoices(): Promise<Voice[]>;
  /**
   * Synthesize speech. Returns null when the provider cannot produce audio
   * server-side (demo mode); the client then falls back to browser TTS.
   */
  synthesize(voiceId: string, text: string, speed: number): Promise<{ audio: Uint8Array; mimeType: string } | null>;
  /** Clone a voice from audio samples; returns the provider's voice id. Absent when the provider cannot clone. */
  cloneVoice?(input: { name: string; samples: Array<{ bytes: Uint8Array; mimeType: string; filename: string }> }): Promise<{ voiceId: string }>;
  deleteVoice?(voiceId: string): Promise<void>;
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
  generate(input: { topic: string; tone: string; lengthSec: number; language: string; audience?: string; source?: string }): Promise<string>;
  /** Transform an existing script: shorten, expand, change tone, translate, or polish. */
  revise(input: { script: string; action: ScriptAction; tone?: string; language?: string }): Promise<string>;
  /** One conversational turn for the interactive avatar: the presenter answers in character, briefly, for speech. */
  chat(input: { persona: ChatPersona; messages: ChatMessage[] }): Promise<string>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatPersona {
  /** Presenter name shown to the visitor. */
  name: string;
  /** What the presenter knows and how it should behave, written by the owner. */
  instructions: string;
  language: string;
}

export interface TranslateProvider {
  readonly name: string;
  createTranslation(input: { sourceVideoUrl: string; targetLanguage: string; title: string }): Promise<{ providerJobId: string }>;
  getStatus(providerJobId: string): Promise<Pick<Translation, "status" | "videoUrl" | "error">>;
  supportedLanguages(): string[];
  parseWebhook?(body: unknown): { providerJobId: string; update: Pick<Translation, "status" | "videoUrl" | "error"> } | null;
}

/** Live video for the interactive avatar. The mock reports "unavailable" and pages fall back to the portrait. */
export interface StreamingProvider {
  readonly name: string;
  readonly available: boolean;
  /** Opens a session; the browser joins the room with the returned URL and token. */
  createSession(input: { avatarId: string; voiceId?: string }): Promise<{ providerSessionId: string; url: string; accessToken: string }>;
  speak(providerSessionId: string, text: string): Promise<void>;
  stop(providerSessionId: string): Promise<void>;
}
