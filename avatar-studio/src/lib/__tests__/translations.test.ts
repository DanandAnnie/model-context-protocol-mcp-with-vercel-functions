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
      return { video_translate_id: "vt_1" };
    };
    await heygen.createTranslation({ sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", title: "T", audioOnly: true, speakers: 2 });
    await heygen.createTranslation({ sourceVideoUrl: base.sourceVideoUrl, targetLanguage: "French", title: "T" });
    assert.deepEqual([bodies[0].translate_audio_only, bodies[0].speaker_num], [true, 2]);
    assert.equal("translate_audio_only" in bodies[1] || "speaker_num" in bodies[1], false, "left to HeyGen's defaults");
  });
});
