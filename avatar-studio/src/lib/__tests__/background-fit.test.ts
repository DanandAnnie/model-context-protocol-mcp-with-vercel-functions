// A picture or video background either fills the frame (cropped) or is shown whole: what is stored, and what HeyGen
// receives. HeyGen's v3 studio always fills the frame, so the fit is kept for the editor and not sent.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createTemplate, createVideo, videoRequestSchema } from "../services";
import { backgroundSchema } from "../services/schemas";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("background fit", () => {
  it("keeps only a fit that shows the whole picture or video", () => {
    assert.deepEqual(backgroundSchema.parse({ type: "image", value: "https://example.com/slide.png", fit: "contain" }), { type: "image", value: "https://example.com/slide.png", fit: "contain" });
    assert.deepEqual(backgroundSchema.parse({ type: "video", value: "https://example.com/loop.mp4", fit: "cover" }), { type: "video", value: "https://example.com/loop.mp4" }, "filling the frame is the default");
    assert.deepEqual(backgroundSchema.parse({ type: "color", value: "#ffffff", fit: "contain" }), { type: "color", value: "#ffffff" }, "a colour has nothing to fit");
    assert.throws(() => backgroundSchema.parse({ type: "image", value: "https://example.com/a.png", fit: "stretch" }));
  });

  it("is stored on each scene and kept by a template; HeyGen fills the frame either way", async () => {
    const req = videoRequestSchema.parse({
      title: "Slides",
      avatarId: STOCK_AVATARS[0].id,
      voiceId: STOCK_VOICES[0].id,
      scenes: [
        { script: "The whole slide.", background: { type: "image", value: "https://example.com/slide.png", fit: "contain" } },
        { script: "A cropped picture.", background: { type: "image", value: "https://example.com/photo.jpg" } },
        { script: "A whole loop.", background: { type: "video", value: "https://example.com/loop.mp4", fit: "contain" } },
      ],
    });
    const video = await createVideo(req, "fitter");
    assert.deepEqual(video.scenes?.map((sc) => sc.background.fit), ["contain", undefined, "contain"]);
    const template = await createTemplate({ fromVideoId: video.id }, "fitter");
    assert.equal(template.scenes[0].background.fit, "contain", "a template keeps the fit");

    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    let sent: { scenes: Array<{ input: { background: Record<string, unknown> } }> } | null = null;
    (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    await heygen.createVideo(req, { ...STOCK_AVATARS[0], provider: "heygen", source: "provider" as const }, { ...STOCK_VOICES[0], provider: "heygen" });
    assert.deepEqual(
      sent!.scenes.map((sc) => sc.input.background),
      [
        { type: "image", source: { type: "url", url: "https://example.com/slide.png" } },
        { type: "image", source: { type: "url", url: "https://example.com/photo.jpg" } },
        { type: "video", source: { type: "url", url: "https://example.com/loop.mp4" } },
      ],
    );
  });
});
