// Avatar engine: a video can ask HeyGen for its higher-quality Avatar V on scenes whose presenter's look supports
// it (v3 `engine: { type: "avatar_v" }`). What is accepted, stored, kept, and sent, and to which presenters.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { batchRequestSchema, createBatch, createTemplate, createVideo, resizeVideo, retryVideo, templateInputSchema, videoRequestSchema } from "../services";
import { getStore } from "../store";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Avatar, Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const base = { title: "Tour", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Welcome in." };

describe("avatar engine", () => {
  it("keeps only Avatar V, HeyGen's default being Avatar IV", () => {
    assert.equal(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_v" }).avatarEngine, "avatar_v");
    assert.equal(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_iv" }).avatarEngine, undefined, "the default is stored as absent");
    assert.equal(videoRequestSchema.safeParse({ ...base, avatarEngine: "avatar_iii" }).success, false);
  });

  it("is stored with the video and kept by templates, retries, other sizes, and batch rows", async () => {
    const video = await createVideo(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_v" }), "eng");
    assert.equal(video.avatarEngine, "avatar_v");
    assert.equal("avatarEngine" in (await createVideo(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_iv" }), "eng")), false);
    assert.equal((await createTemplate({ fromVideoId: video.id }, "eng")).avatarEngine, "avatar_v");
    const spelled = await createTemplate(templateInputSchema.parse({ title: "T", scenes: [{ script: "Hi.", background: { type: "color", value: "#fff" } }], avatarEngine: "avatar_v" }), "eng");
    assert.equal(spelled.avatarEngine, "avatar_v");
    const failed: Video = { ...videoRequestSchema.parse({ ...base, avatarEngine: "avatar_v" }), id: "vid_failed_engine", ownerId: "eng", status: "failed", provider: "mock", error: "boom", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await getStore().put("video", failed);
    const retried = await retryVideo(failed.id, "eng");
    assert.equal(retried.avatarEngine, "avatar_v");
    assert.equal((await resizeVideo(retried.id, { aspects: ["1:1"] }, "eng")).videos[0].avatarEngine, "avatar_v");
    const batch = await createBatch(batchRequestSchema.parse({ title: "B", scriptTemplate: "Hi {name}", csv: "name\nAmy\nBen", avatarId: base.avatarId, voiceId: base.voiceId, avatarEngine: "avatar_v" }), "eng");
    assert.deepEqual(batch.videos.map((v) => v.avatarEngine), ["avatar_v", "avatar_v"]);
  });

  it("lists which HeyGen looks support Avatar V", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("ownership=private")) return Response.json({ data: [], has_more: false });
      return Response.json({
        data: [
          { id: "look_v", name: "Ava", preview_image_url: "https://cdn/1.jpg", avatar_type: "digital_twin", supported_api_engines: ["avatar_v", "avatar_iv", "avatar_iii"] },
          { id: "look_iv", name: "Ben", preview_image_url: "https://cdn/2.jpg", avatar_type: "studio_avatar", supported_api_engines: ["avatar_iv", "avatar_iii"] },
        ],
        has_more: false,
      });
    }) as typeof fetch;
    try {
      const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
      const looks = await new HeyGenAvatarProvider("key").listAvatars();
      assert.deepEqual(looks.map((l) => [l.id, l.avatarV]), [["look_v", true], ["look_iv", undefined]]);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("reaches HeyGen on scenes whose look supports Avatar V, except photo avatars given gestures", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    let sent: { scenes: Array<{ type: string; input?: Record<string, unknown> }> } | null = null;
    (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    const twin: Avatar = { ...STOCK_AVATARS[0], id: "look_twin", provider: "heygen", source: "provider", avatarV: true };
    const studio: Avatar = { ...STOCK_AVATARS[1], id: "look_studio", provider: "heygen", source: "provider", avatarV: undefined };
    const photo: Avatar = { ...STOCK_AVATARS[2], id: "look_photo", provider: "heygen", source: "provider", tags: ["photo avatar"], avatarV: true };
    const voice = { ...STOCK_VOICES[0], provider: "heygen" };
    const bg = { type: "color", value: "#000000" };
    const scenes = [
      { script: "A look with Avatar V.", background: bg },
      { script: "A look without.", background: bg, avatarId: studio.id },
      { script: "A photo look with Avatar V.", background: bg, avatarId: photo.id },
      { script: "Just the view.", background: { type: "image", value: "https://cdn.example.com/view.jpg" }, hidePresenter: true },
    ];
    const cast = { avatars: { [twin.id]: twin, [studio.id]: studio, [photo.id]: photo }, voices: { [voice.id]: voice } };
    const engines = () => sent!.scenes.map((sc) => (sc.input?.engine as { type: string } | undefined)?.type);
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, avatarEngine: "avatar_v", scenes }), twin, voice, cast);
    assert.deepEqual(engines(), ["avatar_v", undefined, "avatar_v", undefined]);
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, avatarEngine: "avatar_v", motionPrompt: "Waves", scenes }), twin, voice, cast);
    assert.deepEqual(engines(), ["avatar_v", undefined, undefined, undefined], "Avatar V can refuse a photo avatar's gestures, so that scene stays on Avatar IV");
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, scenes }), twin, voice, cast);
    assert.deepEqual(engines(), [undefined, undefined, undefined, undefined], "nothing is sent by default");
  });
});
