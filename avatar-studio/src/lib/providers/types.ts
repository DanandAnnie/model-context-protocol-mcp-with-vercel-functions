import type { AudioClip, Avatar, CaptionCue, Translation, TranslationRequest, Video, VideoRequest, Voice } from "../types";

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

/** Avatars and voices referenced by a request's scenes, keyed by id. */
export interface RenderCast {
  avatars: Record<string, Avatar>;
  voices: Record<string, Voice>;
  /** Audio clips the scenes name, already prepared (uploaded) for the renderer. */
  clips?: Record<string, AudioClip>;
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
  /**
   * Kick off a render. Returns the provider's job id. `cast` holds every avatar and voice a
   * scene names (by id, custom avatars already prepared) for providers that render one
   * presenter per scene; others use `avatar` and `voice` throughout.
   */
  createVideo(req: VideoRequest, avatar: Avatar, voice: Voice | null, cast?: RenderCast): Promise<{ providerJobId: string }>;
  /**
   * Make an audio clip usable by this renderer, e.g. by uploading it. Returns the clip with
   * `providerAssetIds[provider]` set; the caller persists it. Renderers without it cannot use audio scenes.
   */
  prepareAudio?(clip: AudioClip, audio: { bytes: Uint8Array; mimeType: string }): Promise<AudioClip>;
  getStatus(providerJobId: string): Promise<AvatarJobStatus>;
  /** Parse an inbound webhook body into a job update, or null if unrecognised. */
  parseWebhook?(body: unknown): { providerJobId: string; update: AvatarJobStatus } | null;
}

export type ScriptAction = "shorten" | "expand" | "tone" | "translate" | "polish";

export interface ScriptProvider {
  readonly name: string;
  generate(input: { topic: string; tone: string; lengthSec: number; language: string; audience?: string; source?: string }): Promise<string>;
  /**
   * Transform an existing script: shorten, expand, change tone, translate, or polish. `terms[i]` is what
   * the token `[[T{i+1}]]` in the script stands for (a brand term kept untranslated), so the words around
   * it can agree with it; the caller puts the term back itself.
   */
  revise(input: { script: string; action: ScriptAction; tone?: string; language?: string; terms?: string[] }): Promise<string>;
  /** One conversational turn for the interactive avatar: the presenter answers in character, briefly, for speech. */
  chat(input: { persona: ChatPersona; messages: ChatMessage[] }): Promise<string>;
  /** A whole video from one prompt (the Video Agent): a title, a frame orientation, and the scenes in order. */
  plan(input: { prompt: string; lengthSec: number; language: string; source?: string }): Promise<VideoPlan>;
}

/** What the Video Agent's planner hands back; the caller trims it to what a video holds. */
export interface VideoPlan {
  title: string;
  orientation: "landscape" | "portrait";
  /** One idea per scene; a close-up suits a hook or a call to action. */
  scenes: { script: string; framing: "full" | "closeUp" }[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatPersona {
  /** Presenter name shown to the visitor. */
  name: string;
  /** What the presenter knows and how it should behave, written by the owner; a knowledge page, when read, follows `KNOWLEDGE_MARKER`. */
  instructions: string;
  language: string;
}

/** Marks where the owner's instructions end and a knowledge page's text begins in `ChatPersona.instructions`. */
export const KNOWLEDGE_MARKER = "Reference material from the page at ";

/** Splits a persona's instructions into the owner's own text and the page text (empty without a page). */
export function splitKnowledge(instructions: string): { own: string; reference: string } {
  const at = instructions.indexOf(`\n\n${KNOWLEDGE_MARKER}`);
  if (at < 0) return { own: instructions, reference: "" };
  const rest = instructions.slice(at + 2 + KNOWLEDGE_MARKER.length);
  const nl = rest.indexOf("\n");
  return { own: instructions.slice(0, at), reference: nl < 0 ? "" : rest.slice(nl + 1) };
}

/** The error a provider reports for a job it has no record of; a new job is given time before it is believed. */
export const TRANSLATION_GONE = "The provider has no record of this translation";

export interface TranslateProvider {
  readonly name: string;
  createTranslation(input: TranslationRequest): Promise<{ providerJobId: string }>;
  /** Whether the video and subtitle links it returns expire, so finished jobs are read again now and then. */
  readonly linksExpire?: boolean;
  getStatus(providerJobId: string): Promise<Pick<Translation, "status" | "videoUrl" | "error" | "captionUrls">>;
  supportedLanguages(): string[];
  parseWebhook?(body: unknown): { providerJobId: string; update: Pick<Translation, "status" | "videoUrl" | "error"> } | null;
  /** Translates the lines without dubbing them yet, so they can be corrected first. */
  createProofread?(input: TranslationRequest): Promise<{ proofreadId: string }>;
  /** The proofread session: still translating, its lines once they are ready, or why it failed. */
  getProofread?(proofreadId: string, input: TranslationRequest): Promise<{ status: "preparing" } | { status: "ready"; cues: CaptionCue[] } | { status: "failed"; error: string }>;
  /** Hands over the corrected lines (an SRT file at `srtUrl`, whose text is `srt`) and starts the dub; its job is then polled like any other. */
  dubProofread?(proofreadId: string, srtUrl: string, srt: string): Promise<{ providerJobId: string }>;
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
