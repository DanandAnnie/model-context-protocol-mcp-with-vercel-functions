// Avatar III engine: a video can ask HeyGen for its re-engineered photo-to-video Avatar III (v3
// `engine: { type: "avatar_iii" }`) at any quality, on scenes whose presenter renders on it. What is accepted, kept,
// and sent, and to which presenters.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { batchRequestSchema, createBatch, createTemplate, createVideo, retryVideo, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { rendersOnAvatarIII, type Avatar, type Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const base = { title: "Tour", avatarId: STOCK_AVATARS[2].id, voiceId: STOCK_VOICES[0].id, script: "Welcome in." };

describe("Avatar III engine", () => {
  it("is accepted at 720p and 1080p, kept with the video, and refuses more blinking, an Avatar V setting", () => {
    assert.equal(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_iii" }).avatarEngine, "avatar_iii");
    assert.equal(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_iii", resolution: "720p" }).avatarEngine, "avatar_iii");
    assert.equal(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_iii", resolution: "4k" }).avatarEngine, "avatar_iii", "4K renders on it anyway");
    const blink = videoRequestSchema.safeParse({ ...base, avatarEngine: "avatar_iii", moreBlinking: true });
    assert.equal(blink.success, false);
    assert.match(blink.error!.issues[0].message, /More blinking is for Avatar V/);
  });

  it("reaches looks that support it, photo avatars included, and digital twins trained here, but not a photo avatar given motion", () => {
    assert.equal(rendersOnAvatarIII({ source: "provider", avatarIII: true }, {}), true);
    assert.equal(rendersOnAvatarIII({ source: "provider", tags: ["photo avatar"], avatarIII: true }, {}), true, "a photo avatar, at up to 1080p");
    assert.equal(rendersOnAvatarIII({ source: "provider", tags: ["photo avatar"], avatarIII: true }, { motionPrompt: "Waves" }), false);
    assert.equal(rendersOnAvatarIII({ source: "provider", tags: ["photo avatar"], avatarIII: true }, { expressiveness: "high" }), false);
    assert.equal(rendersOnAvatarIII({ source: "provider", avatarIII: true }, { motionPrompt: "Waves" }), true, "a video avatar gets no gestures off Avatar V anyway");
    assert.equal(rendersOnAvatarIII({ source: "custom", tags: ["digital twin"] }, {}), true);
    assert.equal(rendersOnAvatarIII({ source: "custom", tags: ["digital twin"] }, { motionPrompt: "Waves", expressiveness: "high" }), true, "a trained twin is a video avatar, not given photo motion");
    assert.equal(rendersOnAvatarIII({ source: "custom" }, {}), false, "an uploaded portrait");
    assert.equal(rendersOnAvatarIII({ source: "provider" }, {}), false, "a look without it");
  });

  it("is kept by templates, retries, and batch rows", async () => {
    const video = await createVideo(videoRequestSchema.parse({ ...base, avatarEngine: "avatar_iii" }), "e3");
    assert.equal(video.avatarEngine, "avatar_iii");
    assert.equal((await createTemplate({ fromVideoId: video.id }, "e3")).avatarEngine, "avatar_iii");
    const at = new Date().toISOString();
    const failed: Video = { ...videoRequestSchema.parse({ ...base, avatarEngine: "avatar_iii" }), id: "vid_failed_iii", ownerId: "e3", status: "failed", provider: "mock", error: "boom", createdAt: at, updatedAt: at };
    await getStore().put("video", failed);
    assert.equal((await retryVideo(failed.id, "e3")).avatarEngine, "avatar_iii");
    const batch = await createBatch(batchRequestSchema.parse({ title: "B", scriptTemplate: "Hi {name}", csv: "name\nAmy\nBen", avatarId: base.avatarId, voiceId: base.voiceId, avatarEngine: "avatar_iii" }), "e3");
    assert.deepEqual(batch.videos.map((v) => v.avatarEngine), ["avatar_iii", "avatar_iii"]);
  });

  it("is sent to HeyGen on scenes whose presenter renders on it, with no motion settings there", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    let sent: { resolution?: string; scenes: Array<{ type: string; input?: Record<string, unknown> }> } | null = null;
    const client = (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client;
    client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_iii" };
    };
    const studio: Avatar = { ...STOCK_AVATARS[0], id: "look_studio", provider: "heygen", source: "provider", avatarIII: true };
    const old: Avatar = { ...STOCK_AVATARS[1], id: "look_old", provider: "heygen", source: "provider", avatarIII: undefined, avatarV: undefined };
    const photo: Avatar = { ...STOCK_AVATARS[2], id: "look_photo", provider: "heygen", source: "provider", tags: ["photo avatar"], avatarIII: true };
    const voice = { ...STOCK_VOICES[0], id: "voice_hg", provider: "heygen" };
    const bg = { type: "color", value: "#000000" };
    const scenes = [
      { script: "A studio look.", background: bg },
      { script: "An older look.", background: bg, avatarId: old.id },
      { script: "A photo avatar.", background: bg, avatarId: photo.id },
      { script: "Just the view.", background: { type: "image", value: "https://cdn.example.com/view.jpg" }, hidePresenter: true },
    ];
    const cast = { avatars: { [studio.id]: studio, [old.id]: old, [photo.id]: photo }, voices: { [voice.id]: voice } };
    const engines = () => sent!.scenes.map((sc) => (sc.input?.engine as { type: string } | undefined)?.type);
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: studio.id, voiceId: voice.id, avatarEngine: "avatar_iii", scenes }), studio, voice, cast);
    assert.deepEqual(engines(), ["avatar_iii", undefined, "avatar_iii", undefined]);
    assert.equal(sent!.resolution, "1080p");
    // A photo avatar given expressiveness stays on Avatar IV with it; the video avatar on Avatar III gets none.
    await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: studio.id, voiceId: voice.id, avatarEngine: "avatar_iii", expressiveness: "high", motionPrompt: "Waves", scenes }), studio, voice, cast);
    assert.deepEqual(engines(), ["avatar_iii", undefined, undefined, undefined]);
    assert.deepEqual(sent!.scenes.map((sc) => [sc.input?.expressiveness, sc.input?.motion_prompt]), [
      [undefined, undefined],
      [undefined, undefined],
      ["high", "Waves"],
      [undefined, undefined],
    ]);
    // A digital twin trained here is a video avatar: on Avatar III it gets none of the motion settings, and on Avatar IV
    // neither expressiveness nor a gesture prompt, which HeyGen refuses for a video avatar there.
    const twin: Avatar = { ...STOCK_AVATARS[3], id: "av_twin", provider: "heygen", source: "custom", tags: ["digital twin"], providerAssetIds: { "heygen:look": "look_twin" } };
    const twinCast = { avatars: { ...cast.avatars, [twin.id]: twin }, voices: cast.voices };
    const withTwin = [{ script: "The twin.", background: bg }];
    for (const avatarEngine of ["avatar_iii", "avatar_iv"]) {
      await heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: twin.id, voiceId: voice.id, avatarEngine, expressiveness: "high", motionPrompt: "Waves", scenes: withTwin }), twin, voice, twinCast);
      const input: Record<string, unknown> = sent!.scenes[0].input!;
      assert.deepEqual([(input.engine as { type: string } | undefined)?.type, input.expressiveness, input.motion_prompt], [avatarEngine === "avatar_iii" ? "avatar_iii" : undefined, undefined, undefined]);
    }
    // A refusal of a render that asked for Avatar III says how to get past it.
    client.generateVideo = async () => {
      throw new Error("HeyGen error: engine_not_supported");
    };
    await assert.rejects(
      heygen.createVideo(videoRequestSchema.parse({ title: "E", avatarId: studio.id, voiceId: voice.id, avatarEngine: "avatar_iii", scenes }), studio, voice, cast),
      /engine_not_supported \(this video asked for Avatar III; if HeyGen refused it, make a copy with Avatar engine set to Avatar IV\)/,
    );
  });
});
