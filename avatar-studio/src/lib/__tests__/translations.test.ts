// Dubbing one video into several languages in one request.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_TRANSLATION_LANGUAGES, createTranslations, listTranslations, translationBatchSchema } from "../services";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const base = { title: "Walkthrough", sourceVideoUrl: "https://cdn.example.com/v.mp4" };

describe("multi-language translation", () => {
  it("accepts one language or a list, ignores repeats without regard to case, and caps the list", () => {
    assert.deepEqual(translationBatchSchema.parse({ ...base, targetLanguage: "Spanish" }).languages, ["Spanish"]);
    assert.deepEqual(translationBatchSchema.parse({ ...base, targetLanguages: ["French", "german", "french", "German"] }).languages, ["French", "german"]);
    assert.equal(translationBatchSchema.safeParse({ ...base }).success, false, "a language is required");
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguages: [] }).success, false);
    const six = ["English", "Spanish", "French", "German", "Italian", "Portuguese"];
    assert.equal(six.length, MAX_TRANSLATION_LANGUAGES + 1);
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguages: six }).success, false);
  });

  it("starts one job per language, each titled with its language", async () => {
    const made = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["French", "German", "Italian"] }), "u-dub");
    assert.deepEqual(made.map((t) => [t.title, t.targetLanguage, t.status]), [
      ["Walkthrough (French)", "French", "processing"],
      ["Walkthrough (German)", "German", "processing"],
      ["Walkthrough (Italian)", "Italian", "processing"],
    ]);
    assert.equal((await listTranslations("u-dub")).length, 3);
    // A single language keeps the title as typed.
    const [one] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "Spanish" }), "u-dub");
    assert.equal(one.title, "Walkthrough");
    assert.equal((await listTranslations("someone-else")).length, 0);
  });

  it("passes voice-only and the speaker count to every dub, and HeyGen gets them as its own fields", async () => {
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguage: "Spanish", speakers: 0 }).success, false);
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguage: "Spanish", speakers: 11 }).success, false);
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguage: "Spanish", speakers: 1.5 }).success, false);
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguage: "Spanish", speakers: "2" }).success, false, "a number, not a string");
    const unset = translationBatchSchema.parse({ ...base, targetLanguage: "Spanish", speakers: null, audioOnly: null });
    assert.equal("speakers" in unset || "audioOnly" in unset, false, "null means not set");
    const made = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["French", "German"], audioOnly: true, speakers: 2 }), "u-opt");
    assert.deepEqual(made.map((t) => [t.audioOnly, t.speakers]), [[true, 2], [true, 2]]);
    const [plain] = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguage: "Spanish", audioOnly: false }), "u-opt");
    assert.equal("audioOnly" in plain, false, "a lip-synced dub stores no flag");
    assert.equal("speakers" in plain, false);

    const { HeyGenTranslateProvider } = await import("../providers/translate/heygen");
    const heygen = new HeyGenTranslateProvider("key");
    const bodies: Array<Record<string, unknown>> = [];
    (heygen as unknown as { client: { createTranslation: (b: Record<string, unknown>) => Promise<unknown> } }).client.createTranslation = async (b) => {
      bodies.push(b);
      return { video_translation_ids: ["vt_1"] };
    };
    await heygen.createTranslation({ sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", title: "T", audioOnly: true, speakers: 2 });
    await heygen.createTranslation({ sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", title: "T" });
    assert.deepEqual([bodies[0].translate_audio_only, bodies[0].speaker_num], [true, 2]);
    assert.equal("translate_audio_only" in bodies[1] || "speaker_num" in bodies[1], false, "left to HeyGen's defaults");
  });

  it("dubs at speed or precision, without the music or with cleaner speech, through HeyGen's v3 translations", async () => {
    assert.equal(translationBatchSchema.safeParse({ ...base, targetLanguage: "Spanish", quality: "best" }).success, false);
    const defaults = translationBatchSchema.parse({ ...base, targetLanguage: "Spanish", quality: "speed", removeMusic: false, enhanceSpeech: null });
    assert.equal("quality" in defaults || "removeMusic" in defaults || "enhanceSpeech" in defaults, false, "defaults are stored as no field");
    const made = await createTranslations(translationBatchSchema.parse({ ...base, targetLanguages: ["French", "German"], quality: "precision", removeMusic: true, enhanceSpeech: true }), "u-q");
    assert.deepEqual(made.map((t) => [t.quality, t.removeMusic, t.enhanceSpeech]), [["precision", true, true], ["precision", true, true]]);

    const { HeyGenTranslateProvider } = await import("../providers/translate/heygen");
    const heygen = new HeyGenTranslateProvider("key");
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let status: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const data = init?.method === "POST" ? { video_translation_ids: ["vt_9"] } : status;
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const { providerJobId } = await heygen.createTranslation({ sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", title: "T", quality: "precision", removeMusic: true, enhanceSpeech: true });
      assert.equal(providerJobId, "vt_9");
      assert.equal(calls[0].url, "https://api.heygen.com/v3/video-translations");
      assert.deepEqual(calls[0].body, { video: { type: "url", url: base.sourceVideoUrl }, output_languages: ["French"], mode: "precision", title: "T", disable_music_track: true, enable_speech_enhancement: true });
      await heygen.createTranslation({ sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", title: "T" });
      assert.equal(calls[1].body?.mode, "speed");
      assert.equal("disable_music_track" in (calls[1].body ?? {}) || "enable_speech_enhancement" in (calls[1].body ?? {}), false);

      status = { status: "running" };
      assert.deepEqual(await heygen.getStatus("vt_9"), { status: "processing" });
      assert.equal(calls.at(-1)?.url, "https://api.heygen.com/v3/video-translations/vt_9");
      status = { status: "pending" };
      assert.deepEqual(await heygen.getStatus("vt_9"), { status: "queued" });
      status = { status: "completed", video_url: "https://files.heygen.ai/v.mp4", srt_caption_url: "https://files.heygen.ai/v.srt", vtt_caption_url: "https://files.heygen.ai/v.vtt" };
      assert.deepEqual(await heygen.getStatus("vt_9"), { status: "completed", videoUrl: "https://files.heygen.ai/v.mp4", captionUrls: { srt: "https://files.heygen.ai/v.srt", vtt: "https://files.heygen.ai/v.vtt" } });
      status = { status: "completed", video_url: "https://files.heygen.ai/v.mp4" };
      assert.deepEqual(await heygen.getStatus("vt_9"), { status: "completed", videoUrl: "https://files.heygen.ai/v.mp4" }, "no caption files, no field");
      status = { status: "failed", failure_message: "Unsupported audio" };
      assert.deepEqual(await heygen.getStatus("vt_9"), { status: "failed", error: "Unsupported audio" });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(heygen.parseWebhook({ event_type: "video_translate.success", event_data: { video_translation_id: "vt_9", video_url: "https://x/v.mp4" } }), { providerJobId: "vt_9", update: { status: "completed", videoUrl: "https://x/v.mp4" } });
  });

  it("picks up a dub's subtitle files when HeyGen's completion callback arrives", async () => {
    const { config } = await import("../config");
    const { getStore } = await import("../store");
    const { applyTranslationWebhook } = await import("../services");
    const original = config.heygenApiKey;
    (config as { heygenApiKey?: string }).heygenApiKey = "key";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { status: "completed", video_url: "https://files.heygen.ai/v.mp4", vtt_caption_url: "https://files.heygen.ai/v.vtt" } }), { status: 200 })) as typeof fetch;
    try {
      await getStore().put("translation", { id: "tr_w", ownerId: "u-w", title: "T", sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", status: "processing", provider: "heygen", providerJobId: "vt_w", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
      const done = await applyTranslationWebhook("heygen", { event_type: "video_translate.success", event_data: { video_translation_id: "vt_w", url: "https://files.heygen.ai/v.mp4" } });
      assert.equal(done?.status, "completed");
      assert.deepEqual(done?.captionUrls, { vtt: "https://files.heygen.ai/v.vtt" });
      // A status read that fails still completes the dub from the callback alone.
      globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
      await getStore().put("translation", { id: "tr_x", ownerId: "u-w", title: "T", sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", status: "processing", provider: "heygen", providerJobId: "vt_x", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
      const alone = await applyTranslationWebhook("heygen", { event_type: "video_translate.success", event_data: { video_translation_id: "vt_x", url: "https://files.heygen.ai/x.mp4" } });
      assert.deepEqual([alone?.status, alone?.videoUrl, alone?.captionUrls], ["completed", "https://files.heygen.ai/x.mp4", undefined]);
    } finally {
      globalThis.fetch = realFetch;
      (config as { heygenApiKey?: string }).heygenApiKey = original;
    }
  });
});
