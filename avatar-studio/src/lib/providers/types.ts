import type { AgentMessage, AgentStyle, AudioClip, Avatar, Backdrop, DirectedScene, CaptionCue, HighlightClip, HighlightFrame, HighlightLength, StudioTemplate, StudioTemplateDetail, Translation, TranslationRequest, Video, VideoRequest, Voice, MusicTrack, AspectRatio, SpokenWord } from "../types";

export interface TtsProvider {
  readonly name: string;
  listVoices(): Promise<Voice[]>;
  /**
   * Synthesize speech. Returns null when the provider cannot produce audio
   * server-side (demo mode); the client then falls back to browser TTS.
   */
  synthesize(voiceId: string, text: string, speed: number): Promise<{ audio: Uint8Array; mimeType: string } | null>;
  /**
   * Clone a voice from audio samples; returns the provider's voice id (and its preview once the provider has one).
   * `oneRecording` providers take exactly one WAV or MP3 recording. Absent when the provider cannot clone.
   */
  cloneVoice?(input: { name: string; samples: Array<{ bytes: Uint8Array; mimeType: string; filename: string }>; language?: string; onCreated?: (voiceId: string) => Promise<void> }): Promise<{ voiceId: string; previewUrl?: string }>;
  /** The provider clones from one WAV or MP3 recording only (the page joins the samples into one before sending). */
  readonly oneRecording?: true;
  deleteVoice?(voiceId: string): Promise<void>;
  /** What the provider says of one voice (a twin's clone, left out of its listing): language, gender, preview. */
  describeVoice?(voiceId: string): Promise<Pick<Voice, "language" | "gender" | "previewUrl">>;
  /**
   * Design voices from a written description (ElevenLabs text-to-voice): a few previews of the sample `text` (written
   * for the description when none is given), each with its audio when the provider makes it server-side. Absent when the
   * provider cannot design voices.
   */
  designVoice?(input: { description: string; text?: string }): Promise<{ text: string; previews: DesignedPreview[] }>;
  /** Keeps a designed preview as a voice of the account's provider; returns its voice id. */
  saveDesignedVoice?(input: { name: string; description: string; previewId: string }): Promise<{ voiceId: string }>;
}

/** One voice a description produced, before it is kept. */
export interface DesignedPreview {
  /** The provider's id for the preview (ElevenLabs' `generated_voice_id`), kept by saving it. */
  previewId: string;
  /** The sample read in this voice; absent in demo mode, where the browser reads it. */
  audio?: { base64: string; mimeType: string };
  durationSec?: number;
}

export interface AvatarJobStatus {
  status: Video["status"];
  videoUrl?: string;
  thumbnailUrl?: string;
  /** A short animated GIF of the render, for an email, where the renderer makes one. */
  gifUrl?: string;
  /** The job to follow from now on, when the renderer moved the render to another (a directed video once it renders). */
  providerJobId?: string;
  /** A directed video under review: its agent is waiting for the account's answer (true) or working (false). */
  agentWaiting?: boolean;
  durationSec?: number;
  error?: string;
}

/** Avatars and voices referenced by a request's scenes, keyed by id. */
/** A file handed to the renderer's Video Agent with a brief: by a link it fetches, or an asset it already holds. */
export type AgentFile = { type: "url"; url: string } | { type: "asset_id"; assetId: string };

export interface RenderCast {
  avatars: Record<string, Avatar>;
  voices: Record<string, Voice>;
  /** Audio clips the scenes name, already prepared (uploaded) for the renderer. */
  clips?: Record<string, AudioClip>;
  /** Uploaded background images the video or its scenes name, prepared like clips. */
  backdrops?: Record<string, Backdrop>;
  /** Generated clips the video or its scenes loop as video backgrounds, each with a link fresh enough to render from. */
  footage?: Record<string, { videoUrl: string }>;
}

export interface AvatarProvider {
  readonly name: string;
  /** Where this renderer keeps the ids of the clips and background images it was given (`providerAssetIds`); its name when absent. */
  readonly assetKey?: string;
  /** True when a finished render's status carries an animated GIF of it (`gifUrl`), so it is worth asking for one. */
  readonly gifPreviews?: boolean;
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
   * The renderer directs a request's `cinematic` shot (HeyGen's Cinematic Avatar): `createVideo` then features the
   * shot's presenters from `cast.avatars` (prepared like any presenter) and needs no voice. Absent when it cannot.
   */
  readonly cinematicShots?: true;
  /** A directed video's voice takes the brand kit's pronunciations (HeyGen: as glossary terms); absent when it cannot. */
  readonly directedPronunciations?: true;
  /**
   * Starts a request's `directed` video from its brief (HeyGen's Video Agent), with the presenter (prepared) and voice
   * only when the request names them; HeyGen chooses otherwise; `files` are the request's pictures and clips to use.
   * Absent when the renderer cannot.
   */
  startDirected?(req: VideoRequest, avatar: Avatar | null, voice: Voice | null, videoId: string, files?: AgentFile[]): Promise<{ providerJobId: string; agentSessionId?: string }>;
  /** The conversation with the agent of a directed video under review, oldest first, and whether it waits for an answer. */
  agentConversation?(sessionId: string): Promise<{ waiting: boolean; progress?: number; messages: AgentMessage[] }>;
  /** An answer to the agent of a directed video under review: feedback, or the go-ahead to render. */
  sendAgentMessage?(sessionId: string, text: string): Promise<void>;
  /** A finished directed render's scenes, in order, and the version of the whole document to edit them against. */
  directedScenes?(renderJobId: string): Promise<{ editVersion: string; scenes: DirectedScene[] }>;
  /** Revises the scenes named (one instruction each) of a render the session made; the new cut is another render to follow. */
  editDirectedScenes?(input: { sessionId: string; renderJobId: string; editVersion: string; edits: Array<{ sceneId: string; text: string }> }): Promise<{ providerJobId: string }>;
  /** The curated styles its Video Agent composes in (`directed.styleId`), where it offers them. */
  listAgentStyles?(): Promise<AgentStyle[]>;
  /**
   * Make an audio clip usable by this renderer, e.g. by uploading it. Returns the clip with
   * `providerAssetIds[provider]` set; the caller persists it. Renderers without it cannot use audio scenes.
   */
  prepareAudio?(clip: AudioClip, audio: { bytes: Uint8Array; mimeType: string }): Promise<AudioClip>;
  /**
   * Make an uploaded background image usable by this renderer, e.g. by uploading it. Returns the backdrop with
   * `providerAssetIds[provider]` set; the caller persists it. Renderers without it show no image backgrounds anyway.
   */
  prepareBackdrop?(backdrop: Backdrop, image: { bytes: Uint8Array; mimeType: string }): Promise<Backdrop>;
  getStatus(providerJobId: string): Promise<AvatarJobStatus>;
  /**
   * Starts a portrait of a presenter who does not exist, drawn from a written description (HeyGen's prompt-to-avatar).
   * Returns a job id to follow with `portraitStatus` (`what` names the look in a failure the renderer gives no reason
   * for). Absent when the provider cannot generate presenters.
   */
  generatePortrait?(input: { name: string; prompt: string }): Promise<{ jobId: string }>;
  /** Where a portrait job stands; a finished one gives the image's URL (https, or a data URL in demo mode). */
  portraitStatus?(jobId: string, what?: "presenter" | "twin"): Promise<{ status: "processing" | "completed" | "failed"; imageUrl?: string; error?: string }>;
  /**
   * Starts cutting a finished video into short highlight clips (HeyGen AI Clipping), one per length, framed as asked.
   * Returns a job id to follow with `highlightsStatus`. Absent when the provider cannot clip videos.
   */
  startHighlights?(input: HighlightInput): Promise<{ jobId: string }>;
  /** Where a clipping job stands, with the clips made so far (each link signed for a limited time). */
  highlightsStatus?(jobId: string): Promise<HighlightStatus>;
  /**
   * Starts cleaning filler words and overlong silences out of a recording (HeyGen filler word removal). `key` makes a
   * retried start return the same job. Absent when the provider cannot clean recordings.
   */
  startCleanup?(input: { videoUrl: string; title: string; key: string }): Promise<{ jobId: string }>;
  /** Where a cleanup stands, with the cleaned cut once it is ready (its link signed for a limited time). */
  cleanupStatus?(jobId: string): Promise<CleanupStatus>;
  /**
   * Starts generating a short clip from a description of the shot, or from a picture as its first frame (HeyGen Video).
   * `key` makes a retried start return the same job. Absent when the provider cannot.
   */
  startFootage?(input: FootageInput): Promise<{ jobId: string }>;
  /** Where a generated clip stands, with the clip once it is ready (its link signed for a limited time). */
  footageStatus?(jobId: string): Promise<FootageStatus>;
  /**
   * Starts a photo shoot: photos of the person in `identity`, their face kept, in the pose, clothing, light, and
   * setting of `reference` (HeyGen Image). `key` makes a retried start return the same job. Absent when the provider
   * cannot.
   */
  startShoot?(input: ShootInput): Promise<{ jobId: string }>;
  /** Where a photo shoot stands, with its photos once they are all ready (their links signed for a limited time). */
  shootStatus?(jobId: string): Promise<ShootStatus>;
  /**
   * Starts putting a new audio track on a video, the speaker's mouth redrawn to match (HeyGen lip sync). `key` makes a
   * retried start return the same job. Absent when the provider cannot lip-sync videos.
   */
  startLipsync?(input: LipsyncInput): Promise<{ jobId: string }>;
  /** Where a lip sync stands, with the video once it is ready (its link signed for a limited time). */
  lipsyncStatus?(jobId: string): Promise<LipsyncStatus>;
  /** Background-music tracks matching a description, best first, each with a short-lived link to hear it. */
  searchMusic?(query: string, kind?: "music" | "effects"): Promise<MusicTrack[]>;
  /**
   * Starts mixing a music track under a finished video (looped to its length, faded in and out), rendered as a new
   * video. `key` makes a retried start return the same job. Absent when the provider cannot.
   */
  startMusicMix?(input: MusicMixInput): Promise<{ jobId: string }>;
  /**
   * Makes an instant voice from one recording (an uploaded asset), named and marked as the studio's. `key` makes a
   * retried start return the same voice. Absent when the provider cannot.
   */
  createInstantVoice?(input: { name: string; assetId: string; image?: { mimeType: string; data: Uint8Array }; key: string }): Promise<{ voiceId: string }>;
  /** Where an instant voice stands; one the renderer no longer has has failed. */
  instantVoiceStatus?(voiceId: string): Promise<{ status: "processing" | "completed" | "failed"; language?: string; error?: string }>;
  /** Deletes an instant voice at the renderer; one already gone is no error. */
  deleteInstantVoice?(voiceId: string): Promise<void>;
  /**
   * A link to an instant voice reading a short preview script in its language, signed for a limited time (so it is
   * asked for each time, never kept); none while the voice is not ready, and `gone`, saying why, for a voice the
   * renderer no longer has or could not make.
   */
  instantVoicePreview?(voiceId: string): Promise<{ url?: string; gone?: string }>;
  /** The renderer's public voices, ready to speak text in (HeyGen Voice), with a short sample of each when it has one. */
  publicVoices?(): Promise<Array<{ voiceId: string; name: string; language?: string; mode: "instant" | "professional"; previewUrl?: string }>>;
  /**
   * Speaks a recording (an uploaded asset) again in an instant voice, keeping its words and timing. Waits up to
   * `waitMs`; a conversion not done by then is "processing", and asking again with the same `key` returns its result
   * once done, without paying twice.
   */
  changeVoice?(input: { voiceId: string; assetId: string; removeNoise: boolean; key: string; waitMs: number }): Promise<{ status: "processing" } | { status: "completed"; audioUrl: string; durationSec: number }>;
  /**
   * Speaks text in an instant voice (HeyGen Voice's text to speech): waits up to `waitMs`, sending `key` as the
   * Idempotency-Key; "processing" means not done by then. Unlike a recording, a text is never asked for again.
   * `words` are when each word was said, where the renderer reports them.
   */
  speakText?(input: { voiceId: string; text: string; turbo?: true; free?: true; expressivenessBoost?: number; key: string; waitMs: number }): Promise<{ status: "processing" } | { status: "completed"; audioUrl: string; durationSec: number; words?: SpokenWord[] }>;
  /** Where a music mix stands, with the video once it is ready (its link signed for a limited time). */
  musicMixStatus?(jobId: string): Promise<LipsyncStatus>;
  /** Deletes a music mix and its video at the renderer; one it no longer has counts as deleted. */
  deleteMusicMix?(jobId: string): Promise<void>;
  /**
   * Starts a set of new looks for a custom photo avatar already prepared for rendering (HeyGen Look Packs): its face in a
   * pack's wardrobe and setting. `key` makes a retried start return the same looks. Each look is followed with
   * `portraitStatus` (a look id, as for a drawn presenter). Absent when the provider cannot.
   */
  startLookPack?(input: { avatar: Avatar; pack: string; gender: "female" | "male"; aspect: "16:9" | "9:16"; key: string }): Promise<{ lookIds: string[] }>;
  /**
   * One new look of a prepared photo avatar drawn from a description of its outfit and setting, guided by up to three
   * wardrobe or setting pictures; the face is the avatar's. Followed with `portraitStatus`, like a pack's looks.
   */
  startDescribedLook?(input: { avatar: Avatar; prompt: string; aspect: "4:5" | "16:9" | "9:16"; references: Array<{ bytes: Uint8Array; mimeType: string }>; key: string }): Promise<{ lookIds: string[] }>;
  /**
   * Starts training a digital twin from footage of a real person (HeyGen digital twin). `key` makes a retried start
   * return the same twin (for a day). Its look is followed with `portraitStatus`, and its consent with
   * `twinConsentStatus`. `voiceId` is the voice the renderer cloned from the footage, when it made one.
   */
  startTwin?(input: { name: string; footageUrl: string; key: string }): Promise<{ lookId: string; groupId: string; voiceId?: string }>;
  /** A page for the person in the footage to record their consent on (valid for a day), and where consent stands. */
  requestTwinConsent?(groupId: string, key: string): Promise<{ url?: string; consent: "pending" | "accepted" | "rejected" }>;
  /**
   * Where the person's consent to a twin stands, with the reason when it was refused; `gone` when the renderer no
   * longer has the twin. `askedAt` is when the consent link was last asked for.
   */
  twinConsentStatus?(groupId: string, askedAt?: string): Promise<{ consent: "not_requested" | "pending" | "accepted" | "rejected"; error?: string; gone?: true }>;
  /** Deletes a voice the renderer cloned for a twin; one it no longer has counts as deleted. */
  deleteTwinVoice?(voiceId: string): Promise<void>;
  /** What a photo avatar made of one of those looks carries, so a render uses the look as it is. */
  lookAssetIds?(lookId: string): Record<string, string>;
  /** The account's HeyGen Studio templates ready to fill. Absent when the provider has none. */
  listStudioTemplates?(): Promise<StudioTemplate[]>;
  /** One template's variables (with their defaults) and scenes. */
  getStudioTemplate?(id: string): Promise<StudioTemplateDetail>;
  /** Parse an inbound webhook body into a job update, or null if unrecognised. */
  /**
   * A webhook's render and its news. `callbackId` is the studio's video id the start was given (a directed video's), for
   * a webhook naming a render the studio does not follow yet (it still follows the agent's session).
   */
  parseWebhook?(body: unknown): { providerJobId: string; update: AvatarJobStatus; callbackId?: string } | null;
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
/** A provider's live session as the server keeps it: its id, and a secret for driving it that never leaves the server. */
export interface ProviderLiveSession {
  id: string;
  secret?: string;
}

export interface StreamingProvider {
  readonly name: string;
  readonly available: boolean;
  /**
   * Whether the browser speaks replies itself, as a command on the room's data channel (LiveAvatar); otherwise
   * `speak` sends them from the server.
   */
  readonly speaksInRoom?: boolean;
  /**
   * Opens a session; the browser joins the room with the returned URL and token. Null when this presenter cannot be
   * shown live, so the page keeps the portrait.
   */
  createSession(input: { avatarId: string; voiceId?: string; custom: boolean }): Promise<{
    session: ProviderLiveSession;
    url: string;
    accessToken: string;
    /** Room participants the browser waits for before the session counts as live. */
    waitFor?: string[];
  } | null>;
  /** A reply was said; a provider whose browser speaks keeps the session alive here instead. */
  speak(session: ProviderLiveSession, text: string): Promise<void>;
  /** Keeps a session from ending as idle while the page shows it. */
  keepAlive?(session: ProviderLiveSession): Promise<void>;
  stop(session: ProviderLiveSession): Promise<void>;
}

export interface HighlightInput {
  /** The finished video, as an address the renderer can download. */
  videoUrl: string;
  title: string;
  lengths: HighlightLength[];
  frame: HighlightFrame;
  captions: boolean;
  prompt?: string;
}

export interface HighlightStatus {
  status: "processing" | "completed" | "failed";
  progress?: number;
  clips: HighlightClip[];
  error?: string;
}

export interface LipsyncInput {
  videoUrl: string;
  /** A public link, or an audio clip already uploaded to the renderer (`prepareAudio`). */
  audio: { type: "url"; url: string } | { type: "asset"; assetId: string };
  mode: "speed" | "precision";
  title: string;
  key: string;
}

export interface MusicMixInput {
  videoUrl: string;
  durationSec: number;
  aspect: AspectRatio;
  musicUrl: string;
  musicDurationSec: number;
  /** The music's gain under the video's sound, 0 to 1. */
  volume: number;
  /** Sound effects, each played once from its moment of the video, at full volume. */
  effects?: Array<{ url: string; atSec: number; durationSec: number }>;
  title: string;
  key: string;
}

export interface LipsyncStatus {
  status: "processing" | "completed" | "failed";
  videoUrl?: string;
  durationSec?: number;
  error?: string;
}

/**
 * One clip to generate: from the description alone, opening on `image` as its first frame, or featuring `references`
 * (named in the description as <Picture 1>, <Picture 2>…). Without `aspect`, a clip from pictures follows the (first)
 * picture's shape. `key` makes a retried start return the same job.
 */
export interface FootageInput {
  prompt: string;
  /** The first frame, inline, or by a link the renderer fetches (a photo shoot's photo). */
  image?: { bytes: Uint8Array; mimeType: string } | { url: string };
  references?: Array<{ bytes: Uint8Array; mimeType: string }>;
  /** Seconds, or "auto" for the renderer to pick a length fitted to the description (reported once the clip is made). */
  durationSec: number | "auto";
  aspect?: "16:9" | "9:16" | "1:1";
  quality: "standard" | "hd";
  /** Send the description as written, without the renderer's prompt enhancement. */
  exact?: boolean;
  /** The take to make again; the renderer picks one when absent. */
  seed?: number;
  key: string;
}

export interface FootageStatus {
  status: "processing" | "completed" | "failed";
  videoUrl?: string;
  durationSec?: number;
  /** The seed the renderer used, to make the same take again. */
  seed?: number;
  width?: number;
  height?: number;
  error?: string;
}

/** One photo shoot to make: 1 to 5 photos of one person, one scene picture, and how many photos to make. */
export interface ShootInput {
  identity: Array<{ bytes: Uint8Array; mimeType: string }>;
  reference: { bytes: Uint8Array; mimeType: string };
  /** Without one, the photos take the scene picture's shape. */
  aspect?: string;
  count: number;
  seed?: number;
  key: string;
}

export interface ShootStatus {
  status: "processing" | "completed" | "failed";
  photos?: Array<{ url: string; width?: number; height?: number; seed?: number }>;
  error?: string;
}

export interface CleanupStatus {
  status: "processing" | "completed" | "failed";
  progress?: number;
  videoUrl?: string;
  thumbnailUrl?: string;
  originalSec?: number;
  outputSec?: number;
  cuts?: number;
  reductionPct?: number;
  error?: string;
}
