import { SAMPLE_PREVIEW_VIDEO, STOCK_AVATARS } from "../../stock";
import type { Avatar, VideoRequest } from "../../types";
import type { AvatarJobStatus, AvatarProvider } from "../types";

/** Public-domain sample clip used to stand in for a rendered avatar video in demo mode (the same one presenters preview). */
const SAMPLE_VIDEO = SAMPLE_PREVIEW_VIDEO;
const SAMPLE_THUMB = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerEscapes.jpg";

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
      videoUrl: SAMPLE_VIDEO,
      thumbnailUrl: SAMPLE_THUMB,
      durationSec: Number(duration),
    };
  }
}
