// 4K videos: HeyGen renders 4K on its Avatar III engine for video avatars (digital twins and studio avatars) whose look
// supports it. What is accepted and refused, which presenters can appear, and what HeyGen is sent.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { batchRequestSchema, cinematicSchema, createBatch, createTemplate, createVideo, fourKProblem, resizeVideo, retryVideo, templateInputSchema, videoRequestSchema } from "../services";
import { brandKitSchema } from "../services/brand";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { FOUR_K_ENGINE, FOUR_K_MOTION, RESOLUTIONS, RESOLUTION_LABELS, dimensionsFor, renders4k, type Avatar, type Video } from "../types";
import type { AvatarProvider } from "../providers/types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

// The first three demo presenters render on Avatar III; the fourth (Daniel Okafor) does not.
const [ava, , , daniel] = STOCK_AVATARS;
const base = { title: "Launch", avatarId: ava.id, voiceId: STOCK_VOICES[0].id, script: "Welcome in.", resolution: "4k" };
const bg = { type: "color", value: "#000000" } as const;

describe("4K videos", () => {
  it("are a quality beside 720p and 1080p, 2160 pixels on the short side", () => {
    assert.deepEqual(RESOLUTIONS, ["720p", "1080p", "4k"]);
    assert.equal(RESOLUTION_LABELS["4k"], "4K");
    assert.deepEqual(dimensionsFor("16:9", "4k"), { width: 3840, height: 2160 });
    assert.deepEqual(dimensionsFor("9:16", "4k"), { width: 2160, height: 3840 });
    assert.deepEqual(dimensionsFor("1:1", "4k"), { width: 2160, height: 2160 });
    assert.deepEqual(dimensionsFor("4:5", "4k"), { width: 2160, height: 2700 });
  });

  it("are refused with Avatar V or motion settings, which Avatar III does not take", () => {
    assert.equal(videoRequestSchema.parse(base).resolution, "4k");
    assert.equal(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_iv" }).resolution, "4k");
    const onV = videoRequestSchema.safeParse({ ...base, avatarEngine: "avatar_v" });
    assert.equal(onV.success, false);
    assert.equal(onV.error!.issues[0].message, FOUR_K_ENGINE);
    for (const motion of [{ expressiveness: "high" }, { motionPrompt: "nods warmly" }]) {
      const r = videoRequestSchema.safeParse({ ...base, ...motion });
      assert.equal(r.success, false);
      assert.equal(r.error!.issues[0].message, FOUR_K_MOTION);
    }
    assert.equal(videoRequestSchema.safeParse({ ...base, resolution: "8k" }).success, false);
  });

  it("are kept by templates and batches; brand kits and cinematic shots stop at 1080p", () => {
    assert.equal(templateInputSchema.shape.resolution.parse("4k"), "4k");
    assert.equal(batchRequestSchema.shape.resolution.parse("4k"), "4k");
    assert.equal(brandKitSchema.shape.defaultResolution.safeParse("4k").success, false);
    assert.equal(cinematicSchema.shape.resolution.safeParse("4k").success, false);
  });

  it("show only presenters that render on Avatar III and are not photos", () => {
    assert.equal(renders4k({ source: "provider", avatarIII: true }), true);
    assert.equal(renders4k({ source: "provider" }), false, "a look without Avatar III");
    assert.equal(renders4k({ source: "provider", tags: ["photo avatar"], avatarIII: true }), false, "a photo avatar tops out at 1080p");
    assert.equal(renders4k({ source: "custom", avatarIII: true }), false, "an uploaded portrait is a photo avatar");
    assert.equal(renders4k({ source: "custom", tags: ["digital twin"] }), true, "a digital twin trained here is a HeyGen digital_twin look");
    assert.deepEqual(STOCK_AVATARS.map(renders4k), [true, true, true, false, false, false, false, false]);
  });

  it("are made, retried, and resized in 4K when every presenter shown supports it", async () => {
    const video = await createVideo(videoRequestSchema.parse(base), "fk");
    assert.equal(video.resolution, "4k");
    assert.equal((await createTemplate({ fromVideoId: video.id }, "fk")).resolution, "4k");
    const at = new Date().toISOString();
    const failed: Video = { ...videoRequestSchema.parse(base), id: "vid_failed_4k", ownerId: "fk", status: "failed", provider: "mock", error: "boom", createdAt: at, updatedAt: at };
    await getStore().put("video", failed);
    const retried = await retryVideo(failed.id, "fk");
    assert.equal(retried.resolution, "4k");
    assert.equal((await resizeVideo(retried.id, { aspects: ["9:16"] }, "fk")).videos[0].resolution, "4k");
    // A scene without the presenter shows none, so its presenter need not render in 4K.
    const cast = { avatars: { [ava.id]: ava, [daniel.id]: daniel }, voices: {} };
    const hidden = [{}, { hidePresenter: true as const, avatarId: daniel.id }];
    assert.equal(fourKProblem({ resolution: "4k", avatarId: ava.id, scenes: hidden }, cast), undefined);
    assert.match(fourKProblem({ resolution: "4k", avatarId: ava.id, scenes: [{}, { avatarId: daniel.id }] }, cast)!, /“Daniel Okafor” tops out at 1080p/);
  });

  it("are refused, before anything is stored, when a presenter shown tops out at 1080p", async () => {
    await assert.rejects(createVideo(videoRequestSchema.parse({ ...base, avatarId: daniel.id }), "fk"), /4K is for digital twins and studio avatars.*“Daniel Okafor” tops out at 1080p/);
    const scenes = [
      { script: "Ava first.", background: bg },
      { script: "Then Daniel.", background: bg, avatarId: daniel.id },
    ];
    await assert.rejects(createVideo(videoRequestSchema.parse({ ...base, scenes }), "fk"), /“Daniel Okafor” tops out at 1080p/);
    assert.equal((await getStore().list("video")).length, 0);
  });

  it("are refused for a whole batch before any row starts", async () => {
    const ask = { title: "B", scriptTemplate: "Hi {name}", csv: "name\nAmy\nBen", avatarId: daniel.id, voiceId: base.voiceId, resolution: "4k" };
    await assert.rejects(createBatch(batchRequestSchema.parse(ask), "fk"), /“Daniel Okafor” tops out at 1080p/);
    assert.equal((await getStore().list("video")).length, 0);
    await assert.rejects(createBatch(batchRequestSchema.parse({ ...ask, avatarId: ava.id, avatarEngine: "avatar_v" }), "fk"), (e: Error) => e.message === FOUR_K_ENGINE);
    const batch = await createBatch(batchRequestSchema.parse({ ...ask, avatarId: ava.id }), "fk");
    assert.deepEqual(batch.videos.map((v) => v.resolution), ["4k", "4k"]);
  });

  it("are made with a digital twin trained here", async () => {
    const at = new Date().toISOString();
    const twin: Avatar = { id: "av_twin_4k", ownerId: "fk", name: "Dana Ruiz", imageUrl: "https://files.example.com/dana.jpg", source: "custom", provider: "mock", tags: ["digital twin"], createdAt: at };
    await getStore().put("avatar", twin);
    assert.equal((await createVideo(videoRequestSchema.parse({ ...base, avatarId: twin.id }), "fk")).resolution, "4k");
  });

  it("are refused by a renderer that stops at 1080p", () => {
    const did = { name: "did" } as AvatarProvider;
    const cast = { avatars: { [ava.id]: ava }, voices: {} };
    assert.match(fourKProblem({ resolution: "4k", avatarId: ava.id }, cast, did)!, /The did renderer makes videos up to 1080p/);
    assert.equal(fourKProblem({ resolution: "1080p", avatarId: daniel.id }, { avatars: { [daniel.id]: daniel }, voices: {} }, did), undefined);
  });

  it("lists which HeyGen looks render on Avatar III", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("ownership=private")) return Response.json({ data: [], has_more: false });
      return Response.json({
        data: [
          { id: "look_twin", name: "Ava", preview_image_url: "https://cdn/1.jpg", avatar_type: "digital_twin", supported_api_engines: ["avatar_iii", "avatar_iv"] },
          { id: "look_old", name: "Ben", preview_image_url: "https://cdn/2.jpg", avatar_type: "studio_avatar", supported_api_engines: ["avatar_iv"] },
          { id: "look_photo", name: "Cy", preview_image_url: "https://cdn/3.jpg", avatar_type: "photo_avatar", supported_api_engines: ["avatar_iii", "avatar_iv"] },
        ],
        has_more: false,
      });
    }) as typeof fetch;
    try {
      const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
      const looks = await new HeyGenAvatarProvider("key").listAvatars();
      assert.deepEqual(looks.map((l) => [l.id, l.avatarIII, renders4k(l)]), [["look_twin", true, true], ["look_old", undefined, false], ["look_photo", true, false]]);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("send HeyGen resolution 4k with Avatar III on every presenter scene, and say how to get past a refusal", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    assert.equal(heygen.renders4k, true);
    let sent: { resolution?: string; scenes: Array<{ type: string; input?: Record<string, unknown> }> } | null = null;
    const client = (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client;
    client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_4k" };
    };
    const twin: Avatar = { ...STOCK_AVATARS[0], id: "look_twin", provider: "heygen", source: "provider", avatarIII: true, avatarV: true };
    const studio: Avatar = { ...STOCK_AVATARS[1], id: "look_studio", provider: "heygen", source: "provider", avatarIII: true };
    const voice = { ...STOCK_VOICES[0], id: "voice_hg", provider: "heygen" };
    const scenes = [
      { script: "The twin.", background: bg },
      { script: "The studio look.", background: bg, avatarId: studio.id },
    ];
    const req = videoRequestSchema.parse({ ...base, avatarId: twin.id, voiceId: voice.id, scenes });
    const cast = { avatars: { [twin.id]: twin, [studio.id]: studio }, voices: { [voice.id]: voice } };
    await heygen.createVideo(req, twin, voice, cast);
    assert.equal(sent!.resolution, "4k");
    assert.deepEqual(sent!.scenes.map((sc) => sc.input?.engine), [{ type: "avatar_iii" }, { type: "avatar_iii" }]);
    assert.equal(sent!.scenes.some((sc) => "motion_prompt" in (sc.input ?? {})), false);
    // At 1080p the same video asks for no engine (HeyGen's default, Avatar IV).
    await heygen.createVideo(videoRequestSchema.parse({ ...base, resolution: "1080p", avatarId: twin.id, voiceId: voice.id, scenes }), twin, voice, cast);
    assert.deepEqual(sent!.scenes.map((sc) => sc.input?.engine), [undefined, undefined]);
    client.generateVideo = async () => {
      throw new Error("HeyGen refused the render: resolution not available");
    };
    await assert.rejects(heygen.createVideo(req, twin, voice, cast), /resolution not available \(this video asked for 4K on Avatar III; if HeyGen refused it, make a copy at 1080p\)/);
  });
});
