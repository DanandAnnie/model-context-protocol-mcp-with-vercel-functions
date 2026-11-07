// 4:5 portrait feed videos: the frame Instagram and LinkedIn feeds show tallest, rendered by HeyGen as aspect_ratio 4:5,
// offered wherever a video's shape is chosen, played in its own frame, and refused only where the renderer has no 4:5
// (the HyperFrames music mix).
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
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { ASPECT_NAMES, ASPECT_RATIOS, dimensionsFor, type Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const ask = (aspect: string) => ({ title: "Feed post", script: "Hello there.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, aspect });

describe("4:5 videos", () => {
  it("are a shape every request that names one takes, beside 16:9, 9:16, and 1:1; other ratios are refused", () => {
    assert.deepEqual([...ASPECT_RATIOS], ["16:9", "9:16", "1:1", "4:5", "5:4"]);
    assert.equal(ASPECT_NAMES["4:5"], "portrait feed");
    assert.equal(videoRequestSchema.parse(ask("4:5")).aspect, "4:5");
    assert.equal(videoRequestSchema.safeParse(ask("4:3")).success, false);
    assert.equal(templateInputSchema.shape.aspect.parse("4:5"), "4:5");
    assert.equal(brandKitSchema.shape.defaultAspect.parse("4:5"), "4:5");
    assert.equal(batchRequestSchema.shape.aspect.parse("4:5"), "4:5");
    assert.deepEqual(resizeSchema.parse({ aspects: ["4:5", "9:16", "4:5"] }).aspects, ["4:5", "9:16"]);
    assert.deepEqual(resizeSchema.parse({ aspects: ["16:9", "9:16", "1:1", "4:5", "5:4"] }).aspects, ["16:9", "9:16", "1:1", "4:5", "5:4"], "every shape may be asked for; the video's own is left out when sizes are made");
    assert.deepEqual(resizeSchema.parse({ aspects: ["9:16", "9:16", "1:1", "4:5"] }).aspects, ["9:16", "1:1", "4:5"]);
  });

  it("are 1080×1350 at 1080p and 720×900 at 720p, and embed and filter as portrait", () => {
    assert.deepEqual(dimensionsFor("4:5"), { width: 1080, height: 1350 });
    assert.deepEqual(dimensionsFor("4:5", "720p"), { width: 720, height: 900 });
    const embed = embedSize("4:5");
    assert.equal(embed.width / embed.height, 4 / 5);
    assert.deepEqual(embedSize("4:5", 200), { width: 200, height: 250 });
    assert.equal(inShape({ aspect: "4:5" }, "portrait"), true);
  });

  it("are sent to HeyGen as aspect_ratio 4:5", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    let sent: { aspect_ratio?: string; resolution?: string } | null = null;
    (heygen as unknown as { client: { generateVideo: (b: unknown) => Promise<{ video_id: string }> } }).client.generateVideo = async (b) => {
      sent = b as { aspect_ratio: string };
      return { video_id: "hg_45" };
    };
    const ava = { ...STOCK_AVATARS[0], id: "ava_hg", provider: "heygen", source: "provider" as const };
    const emma = { ...STOCK_VOICES[0], id: "emma_hg", provider: "heygen" };
    const req = videoRequestSchema.parse({ ...ask("4:5"), avatarId: ava.id, voiceId: emma.id, resolution: "720p" });
    await heygen.createVideo(req, ava, emma, { avatars: { [ava.id]: ava }, voices: { [emma.id]: emma } });
    assert.deepEqual([sent!.aspect_ratio, sent!.resolution], ["4:5", "720p"]);
  });

  it("are refused music, which HeyGen mixes in 16:9, 9:16, or 1:1 only, before the catalog is asked", async () => {
    const at = new Date().toISOString();
    const video = { id: "vid_feed", ownerId: "a45", title: "Feed post", script: "Hello.", avatarId: "stock_1", voiceId: "stock_voice_1", aspect: "4:5", background: { type: "color", value: "#000000" }, captions: false, speed: 1, status: "completed", provider: "mock", videoUrl: "https://files.example.com/feed.mp4", durationSec: 20, createdAt: at, updatedAt: at } as unknown as Video;
    await getStore().put("video", video);
    let searched = 0;
    await assert.rejects(
      startMusic(musicRequestSchema.parse({ videoId: video.id, trackId: "t1", query: "calm piano" }), "a45", { search: () => void searched++ }),
      /16:9, 9:16, and 1:1 videos; make a 1:1 or 9:16 size of this 4:5 video/,
    );
    assert.equal(searched, 0);
  });
});
