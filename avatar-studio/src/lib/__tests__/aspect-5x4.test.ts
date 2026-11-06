// 5:4 landscape feed videos: the wide feed-post frame HeyGen renders as aspect_ratio 5:4, offered wherever a video's
// shape is chosen, played in its own frame, filtered as landscape, and refused only where the renderer has no 5:4 (the
// HyperFrames music mix).
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { musicRequestSchema, resizeSchema, startMusic, videoRequestSchema } from "../services";
import { batchRequestSchema } from "../services/batches";
import { templateInputSchema } from "../services/templates";
import { brandKitSchema } from "../services/brand";
import { embedSize } from "../oembed";
import { inShape } from "../client";
import { slideAspect } from "../pdf-slides";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { ASPECT_NAMES, dimensionsFor, type Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const ask = (aspect: string) => ({ title: "Feed post", script: "Hello there.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, aspect });

describe("5:4 videos", () => {
  it("are a shape every request that names one takes", () => {
    assert.equal(ASPECT_NAMES["5:4"], "landscape feed");
    assert.equal(videoRequestSchema.parse(ask("5:4")).aspect, "5:4");
    assert.equal(videoRequestSchema.safeParse(ask("4:3")).success, false);
    assert.equal(templateInputSchema.shape.aspect.parse("5:4"), "5:4");
    assert.equal(brandKitSchema.shape.defaultAspect.parse("5:4"), "5:4");
    assert.equal(batchRequestSchema.shape.aspect.parse("5:4"), "5:4");
    assert.deepEqual(resizeSchema.parse({ aspects: ["5:4", "9:16", "5:4"] }).aspects, ["5:4", "9:16"]);
  });

  it("are 1350×1080 at 1080p, 900×720 at 720p, and 2700×2160 in 4K, and embed and filter as landscape", () => {
    assert.deepEqual(dimensionsFor("5:4"), { width: 1350, height: 1080 });
    assert.deepEqual(dimensionsFor("5:4", "720p"), { width: 900, height: 720 });
    assert.deepEqual(dimensionsFor("5:4", "4k"), { width: 2700, height: 2160 });
    const embed = embedSize("5:4");
    assert.equal(embed.width / embed.height, 5 / 4);
    assert.deepEqual(embedSize("5:4", 300), { width: 300, height: 240 });
    assert.equal(inShape({ aspect: "5:4" }, "landscape"), true);
    assert.equal(inShape({ aspect: "5:4" }, "portrait"), false);
  });

  it("take a slightly wide PDF page; a 4:3 or 16:9 deck stays 16:9", () => {
    assert.equal(slideAspect(1350, 1080), "5:4");
    assert.equal(slideAspect(1024, 768), "16:9");
    assert.equal(slideAspect(1920, 1080), "16:9");
    assert.equal(slideAspect(1100, 1000), "1:1");
    // At the cut-offs: US Letter landscape (792×612, 1.294) stays 16:9, just past the 5:4 band.
    assert.equal(slideAspect(792, 612), "16:9");
    assert.equal(slideAspect(1290, 1000), "5:4");
    assert.equal(slideAspect(1200, 1000), "5:4");
    assert.equal(slideAspect(1120, 1000), "1:1");
  });

  it("are sent to HeyGen as aspect_ratio 5:4", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    let sent: { aspect_ratio?: string } | null = null;
    (heygen as unknown as { client: { generateVideo: (b: unknown) => Promise<{ video_id: string }> } }).client.generateVideo = async (b) => {
      sent = b as { aspect_ratio: string };
      return { video_id: "hg_54" };
    };
    const ava = { ...STOCK_AVATARS[0], id: "ava_hg", provider: "heygen", source: "provider" as const };
    const emma = { ...STOCK_VOICES[0], id: "emma_hg", provider: "heygen" };
    const req = videoRequestSchema.parse({ ...ask("5:4"), avatarId: ava.id, voiceId: emma.id });
    await heygen.createVideo(req, ava, emma, { avatars: { [ava.id]: ava }, voices: { [emma.id]: emma } });
    assert.equal(sent!.aspect_ratio, "5:4");
  });

  it("are refused music, which HeyGen mixes in 16:9, 9:16, or 1:1 only, before the catalog is asked", async () => {
    const at = new Date().toISOString();
    const video = { id: "vid_wide", ownerId: "a54", title: "Feed post", script: "Hello.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "5:4", background: { type: "color", value: "#000000" }, captions: false, speed: 1, status: "completed", provider: "mock", videoUrl: "https://files.example.com/wide.mp4", durationSec: 20, createdAt: at, updatedAt: at } as unknown as Video;
    await getStore().put("video", video);
    let searched = 0;
    await assert.rejects(
      startMusic(musicRequestSchema.parse({ videoId: video.id, trackId: "t1", query: "calm piano" }), "a54", { search: () => void searched++ }),
      /16:9, 9:16, and 1:1 videos; make a 16:9 or 1:1 size of this 5:4 video/,
    );
    assert.equal(searched, 0);
  });
});
