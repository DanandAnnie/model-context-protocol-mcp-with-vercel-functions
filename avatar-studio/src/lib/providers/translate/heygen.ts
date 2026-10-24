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
      ...(webhookUrl("heygen-translate") ? { callback_url: webhookUrl("heygen-translate") } : {}),
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
  /** Tolerant parser for HeyGen translate callbacks (event_type contains success/fail). */
  parseWebhook(body: unknown) {
    const b = body as { event_type?: string; event_data?: { video_translate_id?: string; id?: string; url?: string; msg?: string; message?: string } };
    const id = b?.event_data?.video_translate_id ?? b?.event_data?.id;
    const type = b?.event_type ?? "";
    if (!id) return null;
    if (/success|complete/i.test(type)) return { providerJobId: id, update: { status: "completed" as const, videoUrl: b.event_data?.url } };
    if (/fail|error/i.test(type)) return { providerJobId: id, update: { status: "failed" as const, error: b.event_data?.msg ?? b.event_data?.message ?? "Translation failed" } };
    return null;
  }
}
