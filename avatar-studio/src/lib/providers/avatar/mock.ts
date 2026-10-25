import { SAMPLE_PREVIEW_VIDEO, STOCK_AVATARS } from "../../stock";
import { demoAssetUrl } from "../../config";
import type { Avatar, VideoRequest } from "../../types";
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

  async createVideo(req: VideoRequest): Promise<{ providerJobId: string }> {
    const words = req.script.trim().split(/\s+/).filter(Boolean).length;
    const durationSec = Math.max(3, Math.round((words / 2.5) / req.speed));
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
