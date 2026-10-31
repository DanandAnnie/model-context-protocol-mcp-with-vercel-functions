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
    const client = (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client;
    client.generateVideo = async (b) => {
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
    const prompts = () => sent!.scenes.map((sc) => sc.input?.motion_prompt);
    assert.deepEqual(prompts(), ["Waves", undefined, "Waves", undefined], "a video avatar on Avatar V takes gestures; one whose look lacks it, never");
    // Both settings: the video avatar on Avatar V takes the gestures but never expressiveness, which Avatar V rejects.
    const both = { title: "E", avatarId: twin.id, voiceId: voice.id, avatarEngine: "avatar_v", expressiveness: "high", motionPrompt: "Waves", scenes };
    await heygen.createVideo(videoRequestSchema.parse(both), twin, voice, cast);
    assert.deepEqual(sent!.scenes.map((sc) => [sc.input?.expressiveness, sc.input?.motion_prompt, (sc.input?.engine as { type: string } | undefined)?.type]), [
      [undefined, "Waves", "avatar_v"],
      [undefined, undefined, undefined],
      ["high", "Waves", undefined],
      [undefined, undefined, undefined],
    ]);
    // A look that supports Avatar V, left on Avatar IV, takes no gestures (HeyGen refuses them there); a scene's own
    // presenter on Avatar V takes them like the video's.
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, motionPrompt: "Waves", scenes }), twin, voice, cast);
    assert.equal(sent!.scenes[0].input?.motion_prompt, undefined);
    const guest = [{ script: "A guest with Avatar V.", background: bg, avatarId: twin.id }];
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: studio.id, voiceId: voice.id, avatarEngine: "avatar_v", motionPrompt: "Waves", scenes: guest }), studio, voice, cast);
    assert.equal(sent!.scenes[0].input?.motion_prompt, "Waves");
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, avatarEngine: "avatar_v", expressiveness: "medium", scenes }), twin, voice, cast);
    assert.deepEqual(engines(), ["avatar_v", undefined, undefined, undefined], "Avatar V rejects expressiveness, so a photo avatar given it stays on Avatar IV");
    assert.equal(sent!.scenes[2].input?.expressiveness, "medium");
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, scenes }), twin, voice, cast);
    assert.deepEqual(engines(), [undefined, undefined, undefined, undefined], "nothing is sent by default");
    // A refusal of a render that asked for Avatar V says how to get past it; one that did not is passed on as it is.
    client.generateVideo = async () => {
      throw new Error("HeyGen error: avatar_consent_required");
    };
    await assert.rejects(heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, avatarEngine: "avatar_v", scenes }), twin, voice, cast), /avatar_consent_required \(this video asked for Avatar V; .*Avatar IV\)/);
    await assert.rejects(heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, scenes }), twin, voice, cast), /^Error: HeyGen error: avatar_consent_required$/);
  });

  it("asks Avatar V for more blinking: only with Avatar V, kept like the engine, sent where a scene renders on it", async () => {
    // Accepted with Avatar V; false is stored as absent; refused without Avatar V rather than quietly dropped.
    assert.equal(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_v", moreBlinking: true }).moreBlinking, true);
    assert.equal(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_v", moreBlinking: false }).moreBlinking, undefined);
    for (const engine of [{}, { avatarEngine: "avatar_iv" }]) {
      const r = videoRequestSchema.safeParse({ ...base, ...engine, moreBlinking: true });
      assert.equal(r.success, false);
      assert.match(r.error!.issues[0].message, /More blinking is for Avatar V/);
    }
    assert.equal(videoRequestSchema.safeParse({ ...base, avatarEngine: "avatar_v", moreBlinking: "yes" }).success, false);
    const scene = [{ script: "Hi.", background: { type: "color", value: "#fff" } }];
    assert.equal(templateInputSchema.safeParse({ title: "T", scenes: scene, moreBlinking: true }).success, false);
    assert.equal(templateInputSchema.parse({ title: "T", scenes: scene, avatarEngine: "avatar_v", moreBlinking: true }).moreBlinking, true);
    const batchBase = { title: "B", scriptTemplate: "Hi {name}", csv: "name\nAmy\nBen", avatarId: base.avatarId, voiceId: base.voiceId };
    assert.equal(batchRequestSchema.safeParse({ ...batchBase, moreBlinking: true }).success, false);

    // Stored with the video and kept wherever the engine is.
    const video = await createVideo(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_v", moreBlinking: true }), "blink");
    assert.equal(video.moreBlinking, true);
    assert.equal("moreBlinking" in (await createVideo(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_v" }), "blink")), false);
    assert.equal((await createTemplate({ fromVideoId: video.id }, "blink")).moreBlinking, true);
    assert.equal((await createTemplate(templateInputSchema.parse({ title: "T", scenes: scene, avatarEngine: "avatar_v", moreBlinking: true }), "blink")).moreBlinking, true);
    const failed: Video = { ...videoRequestSchema.parse({ ...base, avatarEngine: "avatar_v", moreBlinking: true }), id: "vid_failed_blink", ownerId: "blink", status: "failed", provider: "mock", error: "boom", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await getStore().put("video", failed);
    const retried = await retryVideo(failed.id, "blink");
    assert.equal(retried.moreBlinking, true);
    assert.equal((await resizeVideo(retried.id, { aspects: ["1:1"] }, "blink")).videos[0].moreBlinking, true);
    const batch = await createBatch(batchRequestSchema.parse({ ...batchBase, avatarEngine: "avatar_v", moreBlinking: true }), "blink");
    assert.deepEqual(batch.videos.map((v) => v.moreBlinking), [true, true]);

    // HeyGen gets it inside the engine of each scene on Avatar V, and nowhere else.
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    let sent: Record<string, unknown> & { scenes?: Array<{ input?: Record<string, unknown> }> } = {};
    const client = (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client;
    client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    const twin: Avatar = { ...STOCK_AVATARS[0], id: "look_twin", provider: "heygen", source: "provider", avatarV: true };
    const studio: Avatar = { ...STOCK_AVATARS[1], id: "look_studio", provider: "heygen", source: "provider", avatarV: undefined };
    const voice = { ...STOCK_VOICES[0], provider: "heygen" };
    const bg = { type: "color", value: "#000000" };
    const cast = { avatars: { [twin.id]: twin, [studio.id]: studio }, voices: { [voice.id]: voice } };
    const scenes = [
      { script: "On Avatar V.", background: bg },
      { script: "A look without it.", background: bg, avatarId: studio.id },
    ];
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, avatarEngine: "avatar_v", moreBlinking: true, scenes }), twin, voice, cast);
    assert.deepEqual(sent.scenes!.map((sc) => sc.input?.engine), [{ type: "avatar_v", more_blinking: true }, undefined]);
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, avatarEngine: "avatar_v", scenes }), twin, voice, cast);
    assert.deepEqual(sent.scenes![0].input?.engine, { type: "avatar_v" }, "the engine's own blinking by default");
    // A transparent video is v3's single-avatar body, which keeps the engine as it is.
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, avatarEngine: "avatar_v", moreBlinking: true, transparent: true, scenes: [scenes[0]] }), twin, voice, cast);
    assert.equal(sent.output_format, "webm");
    assert.deepEqual(sent.engine, { type: "avatar_v", more_blinking: true });
    // A refusal says blinking may be what to turn off, before giving up Avatar V.
    client.generateVideo = async () => {
      throw new Error("HeyGen error: invalid_parameter");
    };
    await assert.rejects(heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, avatarEngine: "avatar_v", moreBlinking: true, scenes }), twin, voice, cast), /asked for Avatar V with more blinking; .*More blinking off, or with Avatar engine set to Avatar IV\)/);
  });

  it("is decided by one rule in the editor and the renderer", async () => {
    const { rendersOnAvatarV } = await import("../types");
    assert.equal(rendersOnAvatarV({ avatarV: true }, {}), true);
    assert.equal(rendersOnAvatarV({ avatarV: true, tags: ["photo avatar"] }, { expressiveness: "high" }), false);
    assert.equal(rendersOnAvatarV({ avatarV: true, tags: ["photo avatar"] }, { motionPrompt: "Waves" }), false);
    assert.equal(rendersOnAvatarV({ avatarV: true }, { motionPrompt: "Waves" }), true, "a video avatar's look is not a photo avatar");
    assert.equal(rendersOnAvatarV({ source: "custom" }, {}), false, "an uploaded portrait's look is not known to support it");
  });
});
