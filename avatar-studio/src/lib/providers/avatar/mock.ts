import { pauseSeconds, stripPauses } from "../../pauses";
import { SAMPLE_PREVIEW_VIDEO, STOCK_AVATARS } from "../../stock";
import { demoAssetUrl } from "../../config";
import type { AudioClip, Avatar, VideoRequest } from "../../types";
import type { AvatarJobStatus, AvatarProvider } from "../types";

/** Labeled, self-hosted stand-in; no avatar synthesis or paid operation occurs. */
const SAMPLE_VIDEO = SAMPLE_PREVIEW_VIDEO;
const SAMPLE_THUMB = "/demo/poster.svg";

/** Simulates an async render that completes ~12s after submission. */
export class MockAvatarProvider implements AvatarProvider {
  readonly name = "mock";
  private static RENDER_MS = 12_000;

  async listAvatars(): Promise<Avatar[]> {
    return STOCK_AVATARS;
  }

  /** Demo renders need no upload; the clip is marked so a later render skips this step like a real renderer would. */
  async prepareAudio(clip: AudioClip): Promise<AudioClip> {
    return { ...clip, providerAssetIds: { ...clip.providerAssetIds, [this.name]: clip.id } };
  }

  async createVideo(req: VideoRequest): Promise<{ providerJobId: string }> {
    const words = (text: string) => stripPauses(text).trim().split(/\s+/).filter(Boolean).length;
    // An audio scene lasts as long as its clip; a typed one as long as its words take at the chosen speed, plus its pauses.
    const scenes = req.scenes?.length ? req.scenes : [{ script: req.script }];
    const seconds = scenes.reduce((sum, sc) => sum + ("audioSeconds" in sc && sc.audioSeconds ? sc.audioSeconds : words(sc.script) / 2.5 / req.speed + pauseSeconds(sc.script)), 0);
    const durationSec = Math.max(3, Math.round(seconds));
    // Encode submission time + duration in the job id so status needs no state.
    return { providerJobId: `mock_${Date.now()}_${durationSec}` };
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
