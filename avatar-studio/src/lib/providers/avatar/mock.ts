import { spokenWords } from "../../captions";
import { pauseSeconds, stripPauses } from "../../pauses";
import { SAMPLE_PREVIEW_VIDEO, STOCK_AVATARS, portraitSvg } from "../../stock";
import { demoAssetUrl } from "../../config";
import { NotFoundError } from "../../errors";
import type { AgentStyle, AudioClip, Avatar, MusicTrack, StudioTemplate, StudioTemplateDetail, VideoRequest } from "../../types";
import type { AvatarJobStatus, AvatarProvider, CleanupStatus, FootageStatus, HighlightInput, HighlightStatus, LipsyncStatus, ShootStatus } from "../types";
import { SHOOT_ASPECTS, type ShootAspect } from "../../types";

/** Labeled, self-hosted stand-in; no avatar synthesis or paid operation occurs. */
const SAMPLE_VIDEO = SAMPLE_PREVIEW_VIDEO;
const SAMPLE_THUMB = "/demo/poster.svg";
/** A demo photo: a drawn figure on a gradient, in the photo's own shape (at a tenth of its size), its colours from the seed. */
function shootSvg(width: number, height: number, seed: number): string {
  const [w, h] = [Math.round(width / 10), Math.round(height / 10)];
  const hue = seed % 360;
  const r = Math.min(w, h) / 6;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,35%)"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w / 2}" cy="${h / 2 - r}" r="${r}" fill="rgba(255,255,255,0.9)"/><path d="M${w / 2 - 2 * r} ${h} C${w / 2 - 2 * r} ${h / 2 + r} ${w / 2 + 2 * r} ${h / 2 + r} ${w / 2 + 2 * r} ${h} Z" fill="rgba(255,255,255,0.9)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** The demo's Video Agent styles, one per HeyGen style group, each drawn in its own colour. */
const DEMO_AGENT_STYLES: Array<Omit<AgentStyle, "thumbnailUrl" | "previewUrl"> & { hue: number }> = [
  { id: "demo_style_noir", name: "Noir detective", tags: ["cinematic"], aspect: "16:9", hue: 220 },
  { id: "demo_style_crt", name: "Retro CRT", tags: ["retro-tech"], aspect: "16:9", hue: 140 },
  { id: "demo_style_pop", name: "Pop art", tags: ["pop-culture", "iconic-artist"], aspect: "1:1", hue: 330 },
  { id: "demo_style_paper", name: "Paper cut-out", tags: ["handmade"], aspect: "9:16", hue: 35 },
  { id: "demo_style_press", name: "Morning paper", tags: ["print"], aspect: "16:9", hue: 0 },
];

/** A demo style's card: its name on a two-colour field in the style's shape. */
function styleSvg(name: string, hue: number, aspect: "16:9" | "9:16" | "1:1"): string {
  const [w, h] = aspect === "9:16" ? [90, 160] : aspect === "1:1" ? [120, 120] : [160, 90];
  const label = name.replace(/[<>&"']/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="hsl(${hue},45%,30%)"/><rect y="${h * 0.6}" width="${w}" height="${h * 0.4}" fill="hsl(${(hue + 40) % 360},55%,50%)"/><text x="${w / 2}" y="${h * 0.45}" font-family="sans-serif" font-size="11" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** HeyGen Image's delivered sizes for each shape. */
const SHOOT_SIZES: Record<ShootAspect, [number, number]> = { "1:1": [2176, 2176], "2:3": [2176, 3264], "3:2": [3264, 2176], "3:4": [2160, 2880], "4:3": [2880, 2160], "4:5": [2176, 2720], "5:4": [2720, 2176], "9:16": [2160, 3840], "16:9": [3840, 2160] };
const SAMPLE_GIF = "/demo/preview.gif";


/** The demo's background-music tracks (short tones of the studio's own, in public/demo). */
const DEMO_MUSIC = [
  { id: "demo_music_calm", name: "Calm morning", description: "calm ambient soft piano corporate background gentle", previewUrl: "/demo/music-calm.mp3", durationSec: 20 },
  { id: "demo_music_upbeat", name: "Bright steps", description: "upbeat happy energetic pop corporate motivational", previewUrl: "/demo/music-upbeat.mp3", durationSec: 16 },
  { id: "demo_music_cinematic", name: "Wide horizon", description: "cinematic epic dramatic tense inspiring trailer", previewUrl: "/demo/music-cinematic.mp3", durationSec: 24 },
];
const DEMO_EFFECTS = [
  { id: "demo_effect_whoosh", name: "Whoosh", description: "whoosh swoosh transition scene change swipe air", previewUrl: "/demo/effect-whoosh.mp3", durationSec: 0.9 },
  { id: "demo_effect_chime", name: "Bright chime", description: "chime bell ding notification success sparkle", previewUrl: "/demo/effect-chime.mp3", durationSec: 1.3 },
  { id: "demo_effect_pop", name: "Pop", description: "pop click bubble tap button appear", previewUrl: "/demo/effect-pop.mp3", durationSec: 0.4 },
];
/** Simulates an async render that completes ~12s after submission. */
export class MockAvatarProvider implements AvatarProvider {
  readonly name = "mock";
  readonly gifPreviews = true;
  readonly cinematicShots = true as const;
  private static RENDER_MS = 12_000;
  /** How long a demo clipping job takes. */
  private static CLIP_MS = 4_000;

  async listAvatars(): Promise<Avatar[]> {
    return STOCK_AVATARS;
  }

  /** Demo renders need no upload; the clip is marked so a later render skips this step like a real renderer would. */
  async prepareAudio(clip: AudioClip): Promise<AudioClip> {
    return { ...clip, providerAssetIds: { ...clip.providerAssetIds, [this.name]: clip.id } };
  }

  async createVideo(req: VideoRequest): Promise<{ providerJobId: string }> {
    // Words counted as captions count them, so a script written without spaces is not one long word.
    const words = (text: string) => spokenWords(stripPauses(text));
    // An audio scene lasts as long as its clip; a typed one as long as its words take at its speed (the scene's, else the video's), plus its pauses.
    const scenes = req.scenes?.length ? req.scenes : [{ script: req.script }];
    const seconds = scenes.reduce((sum, sc) => sum + ("audioSeconds" in sc && sc.audioSeconds ? sc.audioSeconds : words(sc.script) / 2.5 / (("speed" in sc && sc.speed) || req.speed) + pauseSeconds(sc.script)), 0);
    // A cinematic shot lasts as long as asked, or 8 seconds when the renderer would choose.
    const durationSec = req.cinematic ? (req.cinematic.durationSec ?? 8) : Math.max(3, Math.round(seconds));
    // Encode submission time + duration in the job id so status needs no state.
    return { providerJobId: `mock_${Date.now()}_${durationSec}` };
  }

  /**
   * Demo highlight clips: the sample video stands in for each clip, ready a few seconds after the job starts. The job id
   * carries the start time, lengths, and framing, so following it needs no state; nothing is cut.
   */
  async startHighlights(input: HighlightInput) {
    return { jobId: `mockhl_${Date.now()}_${input.lengths.join("-")}_${input.frame.replace(":", "x")}` };
  }

  async highlightsStatus(jobId: string): Promise<HighlightStatus> {
    const m = /^mockhl_(\d+)_([\d-]+)_(\d+x\d+)$/.exec(jobId);
    if (!m) return { status: "failed", clips: [], error: "No such clipping job" };
    const elapsed = Date.now() - Number(m[1]);
    if (elapsed < MockAvatarProvider.CLIP_MS) return { status: "processing", progress: Math.min(95, Math.round((elapsed / MockAvatarProvider.CLIP_MS) * 100)), clips: [] };
    const clips = m[2].split("-").map((len, i) => ({
      id: `${jobId}_${i}`,
      status: "completed" as const,
      title: `Demo highlight ${i + 1} (${len}s)`,
      durationSec: Number(len),
      viralityScore: 60 + ((Number(m[1]) + i * 17) % 35),
      thumbnailUrl: SAMPLE_THUMB,
      videoUrl: demoAssetUrl(SAMPLE_VIDEO),
    }));
    return { status: "completed", progress: 100, clips };
  }

  /** Demo cleanup: the sample video stands in for the cleaned cut a few seconds later, with made-up statistics; nothing is cut. */
  /** Demo generated clip: the studio's sample clip, "made" a few seconds after it is asked for; nothing is generated. */
  async startFootage({ durationSec, seed }: { durationSec: number; seed?: number }) {
    // The demo picks a seed like the renderer does, and keeps one asked for, so a take can be made again.
    return { jobId: `mockft_${Date.now()}_${durationSec}_${seed ?? Math.floor(Math.random() * 1_000_000)}` };
  }

  async footageStatus(jobId: string): Promise<FootageStatus> {
    const m = /^mockft_(\d+)_(\d+)(?:_(\d+))?$/.exec(jobId);
    if (!m) return { status: "failed", error: "No such clip" };
    if (Date.now() - Number(m[1]) < MockAvatarProvider.CLIP_MS) return { status: "processing" };
    return { status: "completed", videoUrl: demoAssetUrl(SAMPLE_VIDEO), durationSec: Number(m[2]), width: 1280, height: 720, ...(m[3] ? { seed: Number(m[3]) } : {}) };
  }

  /**
   * Demo photo shoot: drawn stand-ins, "made" a few seconds after they are asked for, in the shape asked for (a
   * portrait shape when the scene picture's is to be followed); nothing is generated. Seeds count up from the one
   * asked for, as HeyGen's do.
   */
  async startShoot({ aspect, count, seed }: { aspect?: string; count: number; seed?: number }) {
    const shape = aspect ? SHOOT_ASPECTS.indexOf(aspect as ShootAspect) : -1;
    return { jobId: `mocksh_${Date.now()}_${count}_${seed ?? Math.floor(Math.random() * 1_000_000)}_${shape < 0 ? "x" : shape}` };
  }

  async shootStatus(jobId: string): Promise<ShootStatus> {
    const m = /^mocksh_(\d+)_(\d+)_(\d+)_(x|\d+)$/.exec(jobId);
    if (!m) return { status: "failed", error: "No such photo shoot" };
    if (Date.now() - Number(m[1]) < MockAvatarProvider.CLIP_MS) return { status: "processing" };
    const [width, height] = SHOOT_SIZES[m[4] === "x" ? "3:4" : SHOOT_ASPECTS[Number(m[4])]];
    const seed = Number(m[3]);
    return { status: "completed", photos: Array.from({ length: Number(m[2]) }, (_, i) => ({ url: shootSvg(width, height, seed + i), width, height, seed: seed + i })) };
  }

  async startCleanup() {
    return { jobId: `mockcu_${Date.now()}` };
  }

  async cleanupStatus(jobId: string): Promise<CleanupStatus> {
    const m = /^mockcu_(\d+)$/.exec(jobId);
    if (!m) return { status: "failed", error: "No such cleanup" };
    const elapsed = Date.now() - Number(m[1]);
    if (elapsed < MockAvatarProvider.CLIP_MS) return { status: "processing", progress: Math.min(95, Math.round((elapsed / MockAvatarProvider.CLIP_MS) * 100)) };
    return { status: "completed", progress: 100, videoUrl: demoAssetUrl(SAMPLE_VIDEO), thumbnailUrl: SAMPLE_THUMB, originalSec: 64, outputSec: 58.5, cuts: 7, reductionPct: 8.6 };
  }

  /**
   * Demo look pack: five drawn stand-ins, each a demo portrait of the avatar's name in its own colours, ready at once;
   * nothing is generated. They are followed like drawn presenters.
   */
  async startLookPack({ avatar, pack }: { avatar: Avatar; pack: string }) {
    let hash = 0;
    for (const ch of `${avatar.id}:${pack}`) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
    const name = Buffer.from(Array.from(avatar.name).slice(0, 40).join("")).toString("base64url");
    return { lookIds: Array.from({ length: 5 }, (_, i) => `mockportrait_${(hash + i * 197) % 1000}_${name}`) };
  }

  /** Demo described look: one drawn stand-in of the avatar's name, its colours from the description; nothing is generated. */
  async startDescribedLook({ avatar, prompt }: { avatar: Avatar; prompt: string }) {
    let hash = 0;
    for (const ch of `${avatar.id}:${prompt}`) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
    const name = Buffer.from(Array.from(avatar.name).slice(0, 40).join("")).toString("base64url");
    return { lookIds: [`mockportrait_${hash % 1000}_${name}`] };
  }

  lookAssetIds(lookId: string): Record<string, string> {
    return { [this.name]: lookId };
  }

  /**
   * Demo digital twin: a drawn stand-in of the name, trained at once; consent is "given" a few seconds after its link is
   * asked for (the link is the studio's own page saying so). Nothing is trained and no one is recorded.
   */
  async startTwin({ name }: { name: string }) {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
    const look = `mockportrait_${hash % 1000}_${Buffer.from(Array.from(name).slice(0, 40).join("")).toString("base64url")}`;
    return { lookId: look, groupId: `mockgroup_${Date.now()}`, voiceId: `twinvoice_${hash % 1000}_${Date.now()}` };
  }

  async requestTwinConsent() {
    return { url: "/demo-consent", consent: "pending" as const };
  }

  /** Consent is "given" a few seconds after its link was asked for (the studio keeps when, so any instance agrees). */
  async twinConsentStatus(_groupId: string, askedAt?: string) {
    if (!askedAt) return { consent: "not_requested" as const };
    return { consent: Date.now() - Date.parse(askedAt) >= MockAvatarProvider.CLIP_MS ? ("accepted" as const) : ("pending" as const) };
  }

  async deleteTwinVoice() {}

  /** Demo lip sync: the sample video stands in for the synced one a few seconds later; nothing is redrawn. */
  async startLipsync() {
    return { jobId: `mockls_${Date.now()}` };
  }

  async lipsyncStatus(jobId: string): Promise<LipsyncStatus> {
    const m = /^mockls_(\d+)$/.exec(jobId);
    if (!m) return { status: "failed", error: "No such lip sync" };
    if (Date.now() - Number(m[1]) < MockAvatarProvider.CLIP_MS) return { status: "processing" };
    return { status: "completed", videoUrl: demoAssetUrl(SAMPLE_VIDEO), durationSec: 12 };
  }

  /**
   * Demo background music: three short tracks of the studio's own, ranked by how many of the description's words their
   * description shares (all three when none match). Nothing is searched.
   */
  async searchMusic(query: string, kind: "music" | "effects" = "music"): Promise<MusicTrack[]> {
    const words = query.toLowerCase().match(/[a-z]+/g) ?? [];
    const scored = (kind === "effects" ? DEMO_EFFECTS : DEMO_MUSIC).map((t) => ({ t, score: words.filter((w) => t.description.includes(w)).length }));
    return scored.sort((a, b) => b.score - a.score).map(({ t }) => ({ ...t, previewUrl: demoAssetUrl(t.previewUrl) }));
  }

  /** Demo music mix: the sample video stands in for the mixed one a few seconds later; nothing is mixed. */
  async startMusicMix() {
    return { jobId: `mockmm_${Date.now()}` };
  }

  async deleteMusicMix() {}

  /** A demo instant voice: ready a moment after it is made. The job id carries the time, so following it needs no state. */
  async createInstantVoice() {
    return { voiceId: `mockiv_${Date.now()}` };
  }

  async instantVoiceStatus(voiceId: string): Promise<{ status: "processing" | "completed" | "failed"; language?: string; error?: string }> {
    const m = /^mockiv_(\d+)$/.exec(voiceId);
    if (!m) return { status: "failed", error: "No such voice" };
    return Date.now() - Number(m[1]) < MockAvatarProvider.CLIP_MS / 2 ? { status: "processing" } : { status: "completed", language: "en" };
  }

  async deleteInstantVoice() {}

  /** A demo conversion: a short sample recording stands in for the recording spoken again, at once. */
  async changeVoice(): Promise<{ status: "completed"; audioUrl: string; durationSec: number }> {
    return { status: "completed", audioUrl: demoAssetUrl("/demo/revoiced.mp3"), durationSec: 0 };
  }

  /** Demo text to speech: the same sample recording, its length as the text would take to read aloud. */
  async speakText(input: { text: string }): Promise<{ status: "completed"; audioUrl: string; durationSec: number }> {
    const words = input.text.trim().split(/\s+/).filter(Boolean).length;
    return { status: "completed", audioUrl: demoAssetUrl("/demo/revoiced.mp3"), durationSec: Math.max(1, Math.round((words / 2.5) * 10) / 10) };
  }

  async musicMixStatus(jobId: string): Promise<LipsyncStatus> {
    const m = /^mockmm_(\d+)$/.exec(jobId);
    if (!m) return { status: "failed", error: "No such video with music" };
    if (Date.now() - Number(m[1]) < MockAvatarProvider.CLIP_MS) return { status: "processing" };
    return { status: "completed", videoUrl: demoAssetUrl(SAMPLE_VIDEO), durationSec: 12 };
  }

  /** Demo Studio templates: two layouts to fill in; rendering one is a demo render of its filled-in script. */
  async listStudioTemplates(): Promise<StudioTemplate[]> {
    return DEMO_STUDIO_TEMPLATES.map(({ id, name, thumbnailUrl, aspect }) => ({ id, name, thumbnailUrl, aspect }));
  }

  async getStudioTemplate(id: string): Promise<StudioTemplateDetail> {
    const t = DEMO_STUDIO_TEMPLATES.find((x) => x.id === id);
    if (!t) throw new NotFoundError("Template not found");
    return structuredClone(t);
  }

  /** Demo presenter from a description: an illustrated portrait whose colours follow the description; nothing is generated. */
  async generatePortrait({ name, prompt }: { name: string; prompt: string }) {
    let hash = 0;
    for (const ch of prompt) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
    // Cut by whole characters, so an emoji at the cut is never split.
    return { jobId: `mockportrait_${hash % 1000}_${Buffer.from(Array.from(name).slice(0, 40).join("")).toString("base64url")}` };
  }

  async portraitStatus(jobId: string) {
    const m = /^mockportrait_(\d+)_([A-Za-z0-9_-]*)$/.exec(jobId);
    if (!m) return { status: "failed" as const, error: "No such portrait" };
    return { status: "completed" as const, imageUrl: portraitSvg(Buffer.from(m[2], "base64url").toString() || "AI", Number(m[1])) };
  }

  /**
   * A demo stand-in for HeyGen's Video Agent: the sample video, rendered as a 30-second job. Like HeyGen's, the job
   * starts as the agent's session and moves to its render halfway (see `getStatus`); the brief is not read.
   */
  async startDirected(): Promise<{ providerJobId: string }> {
    return { providerJobId: `mockagent_${Date.now()}` };
  }

  /** Demo stand-ins for HeyGen's Video Agent styles: drawn cards, one per group, and the sample video as each one's sample. */
  async listAgentStyles(): Promise<AgentStyle[]> {
    return DEMO_AGENT_STYLES.map(({ hue, ...s }) => ({ ...s, thumbnailUrl: styleSvg(s.name, hue, s.aspect ?? "16:9"), previewUrl: SAMPLE_VIDEO }));
  }

  async getStatus(providerJobId: string): Promise<AvatarJobStatus> {
    const agent = /^mockagent_(\d+)$/.exec(providerJobId);
    if (agent) {
      // Writing and casting for the first half, then the render, which finishes when any demo render would.
      if (Date.now() - Number(agent[1]) < MockAvatarProvider.RENDER_MS / 2) return { status: "processing" };
      return { status: "processing", providerJobId: `mock_${agent[1]}_30` };
    }
    if (!/^mock_\d+_\d+$/.test(providerJobId)) throw new Error(`Not a demo job id: ${providerJobId}`);
    const [, startedAt, duration] = providerJobId.split("_");
    const elapsed = Date.now() - Number(startedAt);
    if (elapsed < MockAvatarProvider.RENDER_MS) return { status: "processing" };
    return {
      status: "completed",
      videoUrl: demoAssetUrl(SAMPLE_VIDEO),
      thumbnailUrl: demoAssetUrl(SAMPLE_THUMB),
      gifUrl: demoAssetUrl(SAMPLE_GIF),
      durationSec: Number(duration),
    };
  }
}

/** Stand-ins for templates made in HeyGen Studio, so the demo shows the flow; nothing is fetched from HeyGen. */
const DEMO_STUDIO_TEMPLATES: StudioTemplateDetail[] = [
  {
    id: "demo_open_house",
    name: "Open house invitation",
    thumbnailUrl: SAMPLE_THUMB,
    aspect: "16:9",
    variables: {
      agent_name: { type: "text", content: "Ava" },
      address: { type: "text", content: "12 Harbor Lane" },
      open_time: { type: "text", content: "" },
      cover_image: { type: "image", asset: { type: "url", url: "https://images.example.com/house.jpg" }, fit: "cover" },
      presenter: { type: "character", avatar_id: "stock_1" },
      narrator: { type: "voice", voice_id: "stock_voice_1" },
    },
    scenes: [
      { id: "scene_1", script: "Hi, I'm {{agent_name}}. You're invited to an open house at {{address}}.", variables: ["agent_name", "address"] },
      { id: "scene_2", script: "Doors open {{open_time}}. See you there!", variables: ["open_time"] },
    ],
  },
  {
    id: "demo_product_update",
    name: "Product update",
    thumbnailUrl: SAMPLE_THUMB,
    aspect: "9:16",
    variables: {
      headline: { type: "text", content: "What's new this month" },
      details: { type: "text", content: "" },
      presenter: { type: "character", avatar_id: "stock_2" },
    },
    scenes: [{ id: "scene_1", script: "{{headline}}. {{details}}", variables: ["headline", "details"] }],
  },
];
