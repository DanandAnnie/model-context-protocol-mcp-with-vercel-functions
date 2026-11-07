// Voice accent: a video can ask a voice that speaks several accents for one of its language's (HeyGen's v3
// voice_settings.locale). What is accepted, stored, kept, and sent, and to which voices.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { batchRequestSchema, createBatch, createTemplate, createVideo, resizeVideo, retryVideo, templateInputSchema, videoRequestSchema } from "../services";
import { getStore } from "../store";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { accentsFor, voiceTakesAccent } from "../language";
import type { AudioClip, Video, Voice } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const base = { title: "Tour", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Welcome in." };

describe("voice accent", () => {
  it("is one of the listed accents, offered by the voice's language", () => {
    assert.equal(videoRequestSchema.parse({ ...base, accent: "en-GB" }).accent, "en-GB");
    assert.match(JSON.stringify(videoRequestSchema.safeParse({ ...base, accent: "en-XX" }).error?.issues), /listed accents/);
    assert.equal(videoRequestSchema.parse(base).accent, undefined);
    assert.ok(accentsFor("English").includes("en-AU") && !accentsFor("English").includes("es-MX"));
    assert.deepEqual(accentsFor("es-ES").slice(0, 2), ["es-ES", "es-MX"]);
    assert.ok(accentsFor("Multilingual").length > 20, "a voice of no single language is offered them all");
    assert.deepEqual([accentsFor("Swedish"), accentsFor("Cantonese")], [[], []], "a known language with no listed accents is offered none");
    assert.equal(voiceTakesAccent({ accents: true, language: "Swedish" }, "en-GB"), false, "nor sent another language's");
    assert.equal(voiceTakesAccent({ accents: true, language: "English" }, "en-GB"), true);
    assert.equal(voiceTakesAccent({ accents: true, language: "Spanish" }, "en-GB"), false, "not another language's accent");
    assert.equal(voiceTakesAccent({ language: "English" }, "en-GB"), false, "not a voice that speaks one accent");
  });

  it("is stored with the video and kept by templates, retries, other sizes, and batch rows", async () => {
    const video = await createVideo(videoRequestSchema.parse({ ...base, accent: "en-AU" }), "speaker");
    assert.equal(video.accent, "en-AU");
    assert.equal("accent" in (await createVideo(videoRequestSchema.parse(base), "speaker")), false);
    assert.equal((await createTemplate({ fromVideoId: video.id }, "speaker")).accent, "en-AU");
    const spelled = await createTemplate(templateInputSchema.parse({ title: "T", scenes: [{ script: "Hi.", background: { type: "color", value: "#fff" } }], accent: "en-IE" }), "speaker");
    assert.equal(spelled.accent, "en-IE");
    const failed: Video = { ...videoRequestSchema.parse({ ...base, accent: "en-IN" }), id: "vid_failed_accent", ownerId: "speaker", status: "failed", provider: "mock", error: "boom", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await getStore().put("video", failed);
    const retried = await retryVideo(failed.id, "speaker");
    assert.equal(retried.accent, "en-IN");
    assert.equal((await resizeVideo(retried.id, { aspects: ["1:1"] }, "speaker")).videos[0].accent, "en-IN");
    const batch = await createBatch(batchRequestSchema.parse({ title: "B", scriptTemplate: "Hi {name}", csv: "name\nAmy\nBen", avatarId: base.avatarId, voiceId: base.voiceId, accent: "en-GB" }), "speaker");
    assert.deepEqual(batch.videos.map((v) => v.accent), ["en-GB", "en-GB"]);
  });

  it("reaches HeyGen as the locale of scenes whose voice offers that accent, and no others", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    const client = (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client;
    let sent: { scenes: Array<{ type: string; source?: unknown; input?: { voice_settings?: Record<string, unknown> }; voice_settings?: Record<string, unknown> }> } | null = null;
    client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    const studio = { ...STOCK_AVATARS[0], id: "look_studio", provider: "heygen", source: "provider" as const };
    const many: Voice = { id: "v_many", name: "Sara", provider: "heygen", language: "English", accents: true };
    const one: Voice = { id: "v_one", name: "Tom", provider: "heygen", language: "English" };
    const spanish: Voice = { id: "v_es", name: "Lucia", provider: "heygen", language: "Spanish", accents: true };
    const swedish: Voice = { id: "v_sv", name: "Astrid", provider: "heygen", language: "Swedish", accents: true };
    const clip: AudioClip = { id: "clip_1", name: "Take", mimeType: "audio/wav", bytes: 10, durationSec: 3, createdAt: "", providerAssetIds: { "heygen:asset": "clip_asset" } };
    const req = videoRequestSchema.parse({
      title: "Accents",
      avatarId: studio.id,
      voiceId: many.id,
      accent: "en-GB",
      scenes: [
        { script: "The video's voice.", background: { type: "color", value: "#000000" } },
        { script: "A voice of one accent.", background: { type: "color", value: "#000000" }, voiceId: one.id },
        { script: "Hola.", background: { type: "color", value: "#000000" }, voiceId: spanish.id },
        { script: "The view, narrated.", background: { type: "image", value: "https://cdn.example.com/view.jpg" }, hidePresenter: true },
        { script: "Hej.", background: { type: "color", value: "#000000" }, voiceId: swedish.id },
        { script: "As recorded.", background: { type: "color", value: "#000000" }, audioId: clip.id },
        { script: "[pause 2s]", background: { type: "color", value: "#000000" } },
      ],
    });
    client.uploadAsset = async () => "silence_asset";
    await heygen.createVideo(req, studio, many, { avatars: { [studio.id]: studio }, voices: { [many.id]: many, [one.id]: one, [spanish.id]: spanish, [swedish.id]: swedish }, clips: { [clip.id]: clip } });
    const settings = sent!.scenes.map((sc) => sc.input?.voice_settings ?? sc.voice_settings);
    assert.deepEqual(settings.map((s) => s?.locale), ["en-GB", undefined, undefined, "en-GB", undefined, undefined, undefined], "a narrated picture takes it too; recorded audio and silence have no voice to set");
  });
});
