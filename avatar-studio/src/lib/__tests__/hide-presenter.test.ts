// Scenes without the presenter: the scene's picture or video fills the frame, narrated by the voice or a clip, or
// silent (HeyGen v3's whole-frame image and video scenes). What is accepted, stored, kept, and sent.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createTemplate, createVideo, templateInputSchema, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { AudioClip, Avatar, Backdrop } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const issues = (r: { success: boolean; error?: { issues: unknown } }) => JSON.stringify(r.error?.issues ?? []);
const image = { type: "image" as const, value: "https://cdn.example.com/kitchen.jpg" };
const loop = { type: "video" as const, value: "https://cdn.example.com/street.mp4" };
const request = (scenes: unknown[]) => ({ title: "Tour", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, scenes });

describe("scenes without the presenter", () => {
  it("need a picture or video to show, on a video and on a template", () => {
    assert.ok(videoRequestSchema.safeParse(request([{ script: "Hi.", background: image, hidePresenter: true }])).success);
    assert.ok(videoRequestSchema.safeParse(request([{ script: "Hi.", background: loop, hidePresenter: true }])).success);
    assert.match(issues(videoRequestSchema.safeParse(request([{ script: "Hi.", background: { type: "color", value: "#000000" }, hidePresenter: true }]))), /give it an image or video background/);
    assert.equal(videoRequestSchema.safeParse(request([{ script: "Hi.", background: image, hidePresenter: false }])).success, false, "only true is a choice; showing the presenter is the default");
    assert.match(issues(templateInputSchema.safeParse({ title: "T", scenes: [{ script: "Hi.", background: { type: "color", value: "#fff" }, hidePresenter: true }] })), /image or video background/);
  });

  it("are stored without a presenter or layout of their own, and kept by a template", async () => {
    const req = videoRequestSchema.parse(
      request([
        { script: "Welcome in.", background: { type: "color", value: "#0f172a" } },
        { script: "The kitchen was redone last spring.", background: image, hidePresenter: true, avatarId: STOCK_AVATARS[1].id, layout: { scale: 1.2, x: 0.2, y: 0 } },
      ]),
    );
    const video = await createVideo(req, "tourer");
    assert.equal(video.scenes![1].hidePresenter, true);
    assert.equal("avatarId" in video.scenes![1] || "avatarName" in video.scenes![1] || "layout" in video.scenes![1], false, "nothing about a presenter is kept for a scene that shows none");
    assert.equal("hidePresenter" in video.scenes![0], false);
    const template = await createTemplate({ fromVideoId: video.id }, "tourer");
    assert.equal(template.scenes[1].hidePresenter, true, "a template keeps it");
  });

  it("render on HeyGen as whole-frame image and video scenes, narrated, from a clip, or silent", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    const client = (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client;
    let sent: { scenes: Array<Record<string, unknown>> } | null = null;
    client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    const uploads: string[] = [];
    client.uploadAsset = async (_bytes, _mime, name) => {
      uploads.push(name as string);
      return `asset_${uploads.length}`;
    };
    const ava = { ...STOCK_AVATARS[0], id: "ava_hg", provider: "heygen", source: "provider" as const };
    const emma = { ...STOCK_VOICES[0], id: "emma_hg", provider: "heygen" };
    const office: Backdrop = { id: "bd_office", name: "Office", mimeType: "image/png", bytes: 12, createdAt: "", providerAssetIds: { "heygen:asset": "img_1" } };
    const clip: AudioClip = { id: "clip_1", name: "Take", mimeType: "audio/wav", bytes: 10, durationSec: 3, createdAt: "", providerAssetIds: { "heygen:asset": "clip_asset" } };
    const req = videoRequestSchema.parse({
      ...request([
        { script: "Welcome in.", background: { type: "color", value: "#0f172a" } },
        { script: "The kitchen [pause 1s] was redone.", background: image, hidePresenter: true, speed: 0.9 },
        { script: "[pause 3s]", background: image, hidePresenter: true },
        { script: "Around the corner.", background: loop, hidePresenter: true },
        { script: "[pause 2s]", background: loop, hidePresenter: true },
        { script: "As recorded.", background: { type: "image", value: "/api/backdrops/bd_office" }, hidePresenter: true, audioId: clip.id },
      ]),
      avatarId: ava.id,
      voiceId: emma.id,
      pitch: 10,
    });
    await heygen.createVideo(req, ava, emma, { avatars: { [ava.id]: ava }, voices: { [emma.id]: emma }, clips: { [clip.id]: clip }, backdrops: { [office.id]: office } });
    const scenes = sent!.scenes;
    assert.equal(scenes[0].type, "avatar_video", "a scene with the presenter is as before");
    assert.deepEqual(scenes[1], {
      type: "image",
      source: { type: "url", url: image.value },
      script: 'The kitchen <break time="1s"/> was redone.',
      voice_id: emma.id,
      voice_settings: { speed: 0.9, pitch: 10 },
    });
    assert.deepEqual(scenes[2], { type: "image", source: { type: "url", url: image.value }, duration: 3 }, "a silent picture is held, with nothing uploaded");
    assert.deepEqual(scenes[3], { type: "video", source: { type: "url", url: loop.value }, playback: { mode: "loop", mute: true }, script: "Around the corner.", voice_id: emma.id, voice_settings: { speed: 1, pitch: 10 } });
    assert.deepEqual(scenes[4], { type: "video", source: { type: "url", url: loop.value }, playback: { mode: "loop", mute: true }, audio_asset_id: "asset_1" }, "a silent video runs as long as its silence");
    assert.deepEqual(scenes[5], { type: "image", source: { type: "asset_id", asset_id: "img_1" }, audio_asset_id: "clip_asset" });
    assert.deepEqual(uploads, ["silence-2s.wav"], "only the video's silence is uploaded");
    // A presenter that could not render (a portrait HeyGen is still preparing) does not hold up a video whose scenes
    // that would show it are all hidden.
    const pending: Avatar = { id: "ava_custom", name: "Dana", imageUrl: "data:image/png;base64,AA==", source: "custom", provider: "heygen", providerAssetIds: { "heygen:look": "look_1", "heygen:pending": "1" } };
    const onlyPictures = videoRequestSchema.parse(request([{ script: "Just the view.", background: image, hidePresenter: true }]));
    await heygen.createVideo(onlyPictures, pending, emma);
    assert.equal(sent!.scenes[0].type, "image");
  });

  it("are refused by D-ID, which shows its presenter in every scene", async () => {
    const { DidAvatarProvider } = await import("../providers/avatar/did");
    const req = videoRequestSchema.parse(request([{ script: "Just the view.", background: image, hidePresenter: true }]));
    await assert.rejects(new DidAvatarProvider("key").createVideo(req, STOCK_AVATARS[0], STOCK_VOICES[0]), /D-ID shows its presenter in every scene/);
  });
});
