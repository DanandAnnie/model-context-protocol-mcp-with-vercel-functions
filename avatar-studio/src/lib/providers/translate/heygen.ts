import { LANGUAGES } from "../../stock";
import { webhookUrl } from "../../config";
import { HeyGenClient } from "../heygen-client";
import { parseSrt } from "../../captions";
import type { TranslationRequest } from "../../types";
import { TRANSLATION_GONE, type TranslateProvider } from "../types";

/** The largest subtitle file read back from a proofread. */
const MAX_SRT_CHARS = 1_000_000;

/** The source, language, and options of a dub, as both a translation and a proofread take them. */
function dubBody(input: TranslationRequest) {
  return {
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
  };
}

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
      ...dubBody(input),
      ...(webhookUrl("heygen-translate") ? { callback_url: webhookUrl("heygen-translate") } : {}),
    });
    const [id] = data.video_translation_ids ?? [];
    if (!id) throw new Error("HeyGen did not return a translation id");
    return { providerJobId: id };
  }
  async createProofread(input: TranslationRequest) {
    const data = await this.client.createProofread(dubBody(input));
    const [id] = data.proofread_ids ?? [];
    if (!id) throw new Error("HeyGen did not return a proofread id");
    return { proofreadId: id };
  }
  async getProofread(proofreadId: string) {
    const s = await this.client.proofreadStatus(proofreadId);
    if (s.status === "failed") return { status: "failed" as const, error: s.failure_message ?? "The lines could not be translated" };
    if (s.status !== "completed") return { status: "preparing" as const };
    const { srt_url } = await this.client.proofreadSrt(proofreadId);
    if (!srt_url) throw new Error("HeyGen did not return the proofread subtitles");
    const res = await fetch(srt_url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!res.ok) throw new Error(`HeyGen proofread subtitles could not be read: ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_SRT_CHARS) return { status: "failed" as const, error: "The translated lines are too long to proofread here" };
    const cues = parseSrt(text);
    if (!cues.length) return { status: "failed" as const, error: "HeyGen returned no lines to proofread" };
    return { status: "ready" as const, cues };
  }
  async dubProofread(proofreadId: string, srtUrl: string) {
    await this.client.updateProofreadSrt(proofreadId, srtUrl);
    const data = await this.client.generateProofread(proofreadId);
    if (!data.video_translation_id) throw new Error("HeyGen did not return a translation id");
    return { providerJobId: data.video_translation_id };
  }
  async getStatus(providerJobId: string) {
    let s;
    try {
      s = await this.client.translationStatus(providerJobId);
    } catch (err) {
      // A job started through v2 before the move may be unknown to v3: ask v2 instead.
      if (!/ failed: 404\b/.test(err instanceof Error ? err.message : "")) throw err;
      let v2;
      try {
        v2 = await this.client.translationStatusV2(providerJobId);
      } catch (old) {
        // Unknown to both: the job is gone, so it stops being asked about.
        if (/ failed: 404\b/.test(old instanceof Error ? old.message : "")) return { status: "failed" as const, error: TRANSLATION_GONE };
        throw old;
      }
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
