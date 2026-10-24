import { LANGUAGES } from "../../stock";
import type { TranslateProvider } from "../types";

const SAMPLE_VIDEO = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4";

export class MockTranslateProvider implements TranslateProvider {
  readonly name = "mock";
  async createTranslation() {
    return { providerJobId: `mock_tr_${Date.now()}` };
  }
  async getStatus(providerJobId: string) {
    if (!/^mock_tr_\d+$/.test(providerJobId)) throw new Error(`Not a demo job id: ${providerJobId}`);
    const startedAt = Number(providerJobId.split("_")[2]);
    if (Date.now() - startedAt < 15_000) return { status: "processing" as const };
    return { status: "completed" as const, videoUrl: SAMPLE_VIDEO };
  }
  supportedLanguages() {
    return LANGUAGES.map((l) => l.code);
  }
}
