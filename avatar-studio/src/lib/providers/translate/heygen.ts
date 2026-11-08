import { LANGUAGES } from "../../stock";
import { webhookUrl } from "../../config";
import { HeyGenClient } from "../heygen-client";
import { glossaryWith } from "../heygen-glossary";
import { baseLanguageCode } from "../../language";
import { parseSrt } from "../../captions";
import type { TranslationRequest } from "../../types";
import { TRANSLATION_GONE, type TranslateProvider } from "../types";

/** The largest subtitle file read back from a proofread. */
const MAX_SRT_CHARS = 1_000_000;

/** The source, language, and options of a dub, as both a translation and a proofread take them. */
function dubBody(input: TranslationRequest, glossaryId?: string) {
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
    ...(glossaryId ? { brand_glossary_id: glossaryId } : {}),
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
  /**
   * The workspace glossary's id with this dub's rules in it, each in the dub's language: a term to keep, translated to
   * itself (HeyGen's "don't translate" list applies in every language and wins over a forced translation, so it is not
   * used), and a term with a fixed translation, so. A dub whose language has no code HeyGen's rules can name fails
   * rather than writing a rule every language (and every account's dubs) would follow. `fresh` reads the glossary
   * again, for one HeyGen no longer knows.
   */
  private glossaryFor(input: Pick<TranslationRequest, "glossary" | "forcedTranslations" | "targetLanguage">, fresh = false): Promise<string | undefined> {
    const kept = [...new Set((input.glossary ?? []).map((t) => t.trim()).filter(Boolean))].map((term) => ({ term, translation: term }));
    const forced = [...kept, ...(input.forcedTranslations ?? [])];
    if (!forced.length) return Promise.resolve(undefined);
    const code = baseLanguageCode(input.targetLanguage);
    if (!code) throw new Error(`The brand kit's terms cannot be applied to a dub in ${input.targetLanguage}: HeyGen's glossary needs a language it can name; dub without them`);
    return glossaryWith(this.client, { code, forced }, fresh);
  }
  /**
   * Sends a translation or proofread with the glossary for its terms. Refused for the glossary it names (deleted in
   * HeyGen since: a 404, or a refusal that says "glossary"), the glossary is found or made again and the request sent
   * once more; any other refusal, or trouble finding it again, is the request's own error.
   */
  private async withGlossary<T>(input: TranslationRequest, send: (glossaryId?: string) => Promise<T>): Promise<T> {
    const glossaryId = await this.glossaryFor(input);
    try {
      return await send(glossaryId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (!glossaryId || !/ failed: (404\b|4\d\d\b[\s\S]*glossary)/i.test(message)) throw err;
      const again = await this.glossaryFor(input, true).catch(() => undefined);
      if (!again || again === glossaryId) throw err;
      return send(again);
    }
  }
  async createTranslation(input: TranslationRequest) {
    const data = await this.withGlossary(input, (glossaryId) =>
      this.client.createTranslation({
        ...dubBody(input, glossaryId),
        ...(webhookUrl("heygen-translate") ? { callback_url: webhookUrl("heygen-translate") } : {}),
      }),
    );
    const [id] = data.video_translation_ids ?? [];
    if (!id) throw new Error("HeyGen did not return a translation id");
    return { providerJobId: id };
  }
  async createProofread(input: TranslationRequest) {
    const data = await this.withGlossary(input, (glossaryId) => this.client.createProofread(dubBody(input, glossaryId)));
    const [id] = data.proofread_ids ?? [];
    if (!id) throw new Error("HeyGen did not return a proofread id");
    return { proofreadId: id };
  }
  async getProofread(proofreadId: string) {
    const s = await this.client.proofreadStatus(proofreadId);
    if (s.status === "failed") return { status: "failed" as const, error: s.failure_message ?? "The lines could not be translated" };
    if (s.status !== "completed") return { status: "preparing" as const };
    const { srt_url } = await this.client.proofreadSrt(proofreadId);
    if (!srt_url) return { status: "failed" as const, error: "HeyGen did not return the translated lines" };
    const res = await fetch(srt_url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    // A refused link will not start working; a server error, a rate limit, or a file not written yet (403 or 404
    // straight after completion) may pass, so it is asked about again with a fresh link.
    if (res.status >= 400 && res.status < 500 && ![403, 404, 408, 429].includes(res.status)) return { status: "failed" as const, error: `HeyGen's translated lines could not be read (${res.status})` };
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
      // A job started through v2 before the move may be unknown to v3: ask v2 instead (gone, 410, once v2 is retired).
      if (!/ failed: (404|410)\b/.test(err instanceof Error ? err.message : "")) throw err;
      let v2;
      try {
        v2 = await this.client.translationStatusV2(providerJobId);
      } catch (old) {
        // Unknown to both: the job is gone, so it stops being asked about.
        if (/ failed: (404|410)\b/.test(old instanceof Error ? old.message : "")) return { status: "failed" as const, error: TRANSLATION_GONE };
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
