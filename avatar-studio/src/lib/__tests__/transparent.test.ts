// Transparent background: a one-scene video rendered as HeyGen's single-avatar WebM with an alpha channel (v3
// `type: "avatar"`, `output_format: "webm"`), the presenter alone. What is accepted, stored, kept, and sent.
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

const base = { title: "Overlay", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Welcome in." };
const bg = { type: "color" as const, value: "#000000" };
const image = { type: "image" as const, value: "https://cdn.example.com/view.jpg" };
const issues = (r: { error?: { issues: unknown } }) => JSON.stringify(r.error?.issues ?? []);

describe("transparent background", () => {
  it("is for one scene that shows the presenter, on a video and a template", () => {
    assert.equal(videoRequestSchema.parse({ ...base, transparent: true }).transparent, true);
    assert.equal(videoRequestSchema.parse({ ...base, scenes: [{ script: "Hi.", background: bg }], script: undefined, transparent: true }).transparent, true);
    assert.match(issues(videoRequestSchema.safeParse({ ...base, script: undefined, transparent: true, scenes: [{ script: "Hi.", background: bg }, { script: "Bye.", background: bg }] })), /one-scene video that shows the presenter/);
    assert.match(issues(videoRequestSchema.safeParse({ ...base, script: undefined, transparent: true, scenes: [{ script: "The view.", background: image, hidePresenter: true }] })), /one-scene video/);
    assert.equal(videoRequestSchema.safeParse({ ...base, transparent: false }).success, false, "only true is a choice");
    assert.match(issues(templateInputSchema.safeParse({ title: "T", transparent: true, scenes: [{ script: "Hi.", background: bg }, { script: "Bye.", background: bg }] })), /one-scene template/);
  });

  it("is stored with the video and kept by templates, retries, other sizes, and batch rows", async () => {
    const video = await createVideo(videoRequestSchema.parse({ ...base, transparent: true }), "alpha");
    assert.equal(video.transparent, true);
    assert.equal("transparent" in (await createVideo(videoRequestSchema.parse(base), "alpha")), false);
    assert.equal((await createTemplate({ fromVideoId: video.id }, "alpha")).transparent, true);
    const failed: Video = { ...videoRequestSchema.parse({ ...base, transparent: true }), id: "vid_failed_alpha", ownerId: "alpha", status: "failed", provider: "mock", error: "boom", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await getStore().put("video", failed);
    const retried = await retryVideo(failed.id, "alpha");
    assert.equal(retried.transparent, true);
    assert.equal((await resizeVideo(retried.id, { aspects: ["9:16"] }, "alpha")).videos[0].transparent, true);
    const batch = await createBatch(batchRequestSchema.parse({ title: "B", scriptTemplate: "Hi {name}", csv: "name\nAmy", avatarId: base.avatarId, voiceId: base.voiceId, transparent: true }), "alpha");
    assert.equal(batch.videos[0].transparent, true);
  });

  it("reaches HeyGen as a single-avatar WebM with no background or burned captions, and D-ID refuses it", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    const last: { body?: Record<string, unknown> } = {};
    (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client.generateVideo = async (b) => {
      last.body = b as Record<string, unknown>;
      return { video_id: "hg_1" };
    };
    const twin: Avatar = { ...STOCK_AVATARS[0], id: "look_twin", provider: "heygen", source: "provider", avatarV: true };
    const voice = { ...STOCK_VOICES[0], provider: "heygen" };
    const req = videoRequestSchema.parse({ title: "Overlay", avatarId: twin.id, voiceId: voice.id, transparent: true, captions: true, avatarEngine: "avatar_v", motionPrompt: "Waves", scenes: [{ script: "Hi [pause 1s] there.", background: image, speed: 1.1 }] });
    await heygen.createVideo(req, twin, voice, { avatars: { [twin.id]: twin }, voices: { [voice.id]: voice } });
    assert.deepEqual(last.body, {
      type: "avatar",
      title: "Overlay",
      aspect_ratio: "16:9",
      resolution: "1080p",
      output_format: "webm",
      avatar_id: "look_twin",
      script: 'Hi <break time="1s"/> there.',
      voice_id: voice.id,
      voice_settings: { speed: 1.1 },
      motion_prompt: "Waves",
      engine: { type: "avatar_v" },
    });
    // Without it, the same video is a studio composition with its background and captions, as before.
    await heygen.createVideo(videoRequestSchema.parse({ ...req, transparent: undefined }), twin, voice, { avatars: { [twin.id]: twin }, voices: { [voice.id]: voice } });
    assert.equal(last.body?.type, "studio");
    const { DidAvatarProvider } = await import("../providers/avatar/did");
    await assert.rejects(new DidAvatarProvider("key").createVideo(videoRequestSchema.parse({ ...base, transparent: true }), STOCK_AVATARS[0], STOCK_VOICES[0]), /D-ID renders an MP4 with a background/);
  });

  it("keeps its captions on the share page's track, which plays by default, and is typed as a WebM", async () => {
    const { captionsBurnedIn } = await import("../captions");
    const { isWebm, shareBodyFor } = await import("../share-body");
    const now = new Date().toISOString();
    const video: Video = { ...videoRequestSchema.parse({ ...base, captions: true, transparent: true }), id: "vid_alpha_cc", ownerId: "alpha", status: "completed", provider: "heygen", videoUrl: "https://files.heygen.ai/v/alpha.webm?Expires=1&Signature=x", createdAt: now, updatedAt: now };
    assert.equal(captionsBurnedIn(video), false, "nothing is burned over the alpha");
    assert.equal(shareBodyFor(video, null).player?.trackDefault, true);
    assert.equal(captionsBurnedIn({ ...video, transparent: undefined }), true, "an opaque HeyGen video still burns them in");
    assert.equal(isWebm(video), true);
    assert.equal(isWebm({ ...video, transparent: undefined }), true, "a signed link's query does not hide the extension");
    assert.equal(isWebm({ ...video, transparent: undefined, videoUrl: "https://files.heygen.ai/v/a.mp4?x=.webm" }), false);
  });

  it("neither looks up nor uploads a background it never sends", async () => {
    // An uploaded image that no longer exists would be a 404 for an opaque video; a transparent one renders without it.
    const gone = { type: "image" as const, value: "/api/backdrops/bd_missing1" };
    const video = await createVideo(videoRequestSchema.parse({ ...base, script: undefined, transparent: true, scenes: [{ script: "Hi.", background: gone }] }), "alpha");
    assert.equal(video.status, "processing");
    await assert.rejects(createVideo(videoRequestSchema.parse({ ...base, script: undefined, scenes: [{ script: "Hi.", background: gone }] }), "alpha"), /not found/i);
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    const last: { body?: Record<string, unknown> } = {};
    const client = (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client;
    client.generateVideo = async (b) => {
      last.body = b as Record<string, unknown>;
      return { video_id: "hg_2" };
    };
    const twin: Avatar = { ...STOCK_AVATARS[0], id: "look_twin", provider: "heygen", source: "provider" };
    const voice = { ...STOCK_VOICES[0], provider: "heygen" };
    const cast = { avatars: { [twin.id]: twin }, voices: { [voice.id]: voice }, clips: { clip_1: { id: "clip_1", providerAssetIds: { "heygen:asset": "asset_clip" } } } } as unknown as Parameters<typeof heygen.createVideo>[3];
    // A colour HeyGen could not take (it is never sent) and a recorded clip: the clip is the sound, with no voice settings.
    await heygen.createVideo(videoRequestSchema.parse({ ...base, avatarId: twin.id, voiceId: voice.id, script: undefined, transparent: true, scenes: [{ script: "Hi.", background: { type: "color", value: "white" }, audioId: "clip_1" }] }), twin, voice, cast);
    assert.equal(last.body?.audio_asset_id, "asset_clip");
    assert.equal("voice_settings" in (last.body ?? {}), false);
    assert.equal("background" in (last.body ?? {}), false);
  });
});
