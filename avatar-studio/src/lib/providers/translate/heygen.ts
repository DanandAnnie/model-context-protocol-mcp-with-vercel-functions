import { LANGUAGES } from "../../stock";
import { webhookUrl } from "../../config";
import { HeyGenClient } from "../heygen-client";
import type { TranslationRequest } from "../../types";
import type { TranslateProvider } from "../types";

export class HeyGenTranslateProvider implements TranslateProvider {
  readonly name = "heygen";
  /** HeyGen's video and subtitle URLs are presigned and expire. */
  readonly linksExpire = true;
  private client: HeyGenClient;
  constructor(apiKey: string) {
    this.client = new HeyGenClient(apiKey);
  }
  async createTranslation(input: TranslationRequest) {
    const data = await this.client.createTranslation({
      video: { type: "url", url: input.sourceVideoUrl },
      output_languages: [input.targetLanguage],
      mode: input.quality ?? "speed",
      title: input.title,
      // HeyGen lip-syncs, keeps the music, and leaves the speech as recorded unless told otherwise; the speaker
      // count is its own guess when left out.
      ...(input.audioOnly ? { translate_audio_only: true } : {}),
      ...(input.speakers ? { speaker_num: input.speakers } : {}),
      ...(input.removeMusic ? { disable_music_track: true } : {}),
      ...(input.enhanceSpeech ? { enable_speech_enhancement: true } : {}),
      ...(webhookUrl("heygen-translate") ? { callback_url: webhookUrl("heygen-translate") } : {}),
    });
    const [id] = data.video_translation_ids ?? [];
    if (!id) throw new Error("HeyGen did not return a translation id");
    return { providerJobId: id };
  }
  async getStatus(providerJobId: string) {
    let s;
    try {
      s = await this.client.translationStatus(providerJobId);
    } catch (err) {
      // A job started through v2 before the move may be unknown to v3: ask v2 instead.
      if (!/ failed: 404\b/.test(err instanceof Error ? err.message : "")) throw err;
      const v2 = await this.client.translationStatusV2(providerJobId);
      if (v2.status === "success") return { status: "completed" as const, videoUrl: v2.url };
      if (v2.status === "failed") return { status: "failed" as const, error: v2.message ?? "Translation failed" };
      return { status: v2.status === "pending" ? ("queued" as const) : ("processing" as const) };
    }
    if (s.status === "completed") {
      const captionUrls = { ...(s.srt_caption_url ? { srt: s.srt_caption_url } : {}), ...(s.vtt_caption_url ? { vtt: s.vtt_caption_url } : {}) };
      return { status: "completed" as const, videoUrl: s.video_url, ...(Object.keys(captionUrls).length ? { captionUrls } : {}) };
    }
    if (s.status === "failed") return { status: "failed" as const, error: s.failure_message ?? "Translation failed" };
    return { status: s.status === "pending" ? ("queued" as const) : ("processing" as const) };
  }
  supportedLanguages() {
    return LANGUAGES.map((l) => l.code);
  }
  /** Tolerant parser for HeyGen translate callbacks (event_type contains success/fail). */
  parseWebhook(body: unknown) {
    const b = body as { event_type?: string; event_data?: { video_translation_id?: string; video_translate_id?: string; id?: string; url?: string; video_url?: string; msg?: string; message?: string; failure_message?: string } };
    const id = b?.event_data?.video_translation_id ?? b?.event_data?.video_translate_id ?? b?.event_data?.id;
    const type = b?.event_type ?? "";
    if (!id) return null;
    if (/success|complete/i.test(type)) return { providerJobId: id, update: { status: "completed" as const, videoUrl: b.event_data?.video_url ?? b.event_data?.url } };
    if (/fail|error/i.test(type)) return { providerJobId: id, update: { status: "failed" as const, error: b.event_data?.failure_message ?? b.event_data?.msg ?? b.event_data?.message ?? "Translation failed" } };
    return null;
  }
}
