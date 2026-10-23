import { LANGUAGES } from "../../stock";
import { webhookUrl } from "../../config";
import { HeyGenClient } from "../heygen-client";
import type { TranslateProvider } from "../types";

export class HeyGenTranslateProvider implements TranslateProvider {
  readonly name = "heygen";
  private client: HeyGenClient;
  constructor(apiKey: string) {
    this.client = new HeyGenClient(apiKey);
  }
  async createTranslation(input: { sourceVideoUrl: string; targetLanguage: string; title: string }) {
    const data = await this.client.createTranslation({
      video_url: input.sourceVideoUrl,
      output_language: input.targetLanguage,
      title: input.title,
      callback_url: webhookUrl("heygen-translate"),
    });
    return { providerJobId: data.video_translate_id };
  }
  async getStatus(providerJobId: string) {
    const s = await this.client.translationStatus(providerJobId);
    if (s.status === "success") return { status: "completed" as const, videoUrl: s.url };
    if (s.status === "failed") return { status: "failed" as const, error: s.message ?? "Translation failed" };
    return { status: s.status === "pending" ? ("queued" as const) : ("processing" as const) };
  }
  supportedLanguages() {
    return LANGUAGES.map((l) => l.code);
  }
}
