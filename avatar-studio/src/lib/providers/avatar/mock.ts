import { spokenWords } from "../../captions";
import { pauseSeconds, stripPauses } from "../../pauses";
import { SAMPLE_PREVIEW_VIDEO, STOCK_AVATARS, portraitSvg } from "../../stock";
import { demoAssetUrl } from "../../config";
import { NotFoundError } from "../../errors";
import type { AudioClip, Avatar, StudioTemplate, StudioTemplateDetail, VideoRequest } from "../../types";
import type { AvatarJobStatus, AvatarProvider, CleanupStatus, HighlightInput, HighlightStatus } from "../types";

/** Labeled, self-hosted stand-in; no avatar synthesis or paid operation occurs. */
const SAMPLE_VIDEO = SAMPLE_PREVIEW_VIDEO;
const SAMPLE_THUMB = "/demo/poster.svg";

/** Simulates an async render that completes ~12s after submission. */
export class MockAvatarProvider implements AvatarProvider {
  readonly name = "mock";
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
    const durationSec = Math.max(3, Math.round(seconds));
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

  async getStatus(providerJobId: string): Promise<AvatarJobStatus> {
    if (!/^mock_\d+_\d+$/.test(providerJobId)) throw new Error(`Not a demo job id: ${providerJobId}`);
    const [, startedAt, duration] = providerJobId.split("_");
    const elapsed = Date.now() - Number(startedAt);
    if (elapsed < MockAvatarProvider.RENDER_MS) return { status: "processing" };
    return {
      status: "completed",
      videoUrl: demoAssetUrl(SAMPLE_VIDEO),
      thumbnailUrl: demoAssetUrl(SAMPLE_THUMB),
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
