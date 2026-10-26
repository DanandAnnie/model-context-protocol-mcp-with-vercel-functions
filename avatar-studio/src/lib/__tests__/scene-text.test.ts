// On-screen text for a scene (a title, a lower third): what is stored, what a template keeps, and what HeyGen receives.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createTemplate, createVideo, templateInputSchema, videoRequestSchema } from "../services";
import { sceneTextSchema } from "../services/schemas";
import { sceneText } from "../providers/avatar/heygen";
import { sceneTextFits } from "../types";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("scene text", () => {
  it("is one line with its defaults left out, and blank text is none", () => {
    assert.deepEqual(sceneTextSchema.parse({ text: "  Dana Lee\n  Listing agent ", position: "top", size: "medium", color: "#FFFFFF" }), { text: "Dana Lee Listing agent" });
    assert.deepEqual(sceneTextSchema.parse({ text: "$450,000", position: "bottom", size: "large", color: "#FACC15" }), { text: "$450,000", position: "bottom", size: "large", color: "#facc15" });
    assert.equal(sceneTextSchema.parse({ text: "   ", position: "center" }), undefined);
    assert.throws(() => sceneTextSchema.parse({ text: "x".repeat(121) }), /120 characters/);
    // Whole characters count, as the editor counts them: an emoji is one.
    assert.deepEqual(sceneTextSchema.parse({ text: "🏡".repeat(120) }), { text: "🏡".repeat(120) });
    assert.throws(() => sceneTextSchema.parse({ text: "🏡".repeat(121) }), /120 characters/);
    // The length is the text's once its spaces are collapsed, as stored.
    assert.deepEqual(sceneTextSchema.parse({ text: `a${" ".repeat(300)}b` }), { text: "a b" });
    assert.throws(() => sceneTextSchema.parse({ text: "Hi", color: "red" }), /hex colour/);
    assert.throws(() => sceneTextSchema.parse({ text: "Hi", position: "left" }));
  });

  it("knows when a line is too long for the frame at its size", () => {
    assert.equal(sceneTextFits({ text: "Dana Lee, Listing agent" }, "16:9"), true);
    assert.equal(sceneTextFits({ text: "Dana Lee, Listing agent", size: "large" }, "9:16"), false);
    assert.equal(sceneTextFits({ text: "Dana Lee, Listing agent", size: "small" }, "9:16"), true);
    assert.equal(sceneTextFits({ text: "x".repeat(120), size: "small" }, "16:9"), false);
  });

  it("is stored on its scene, kept by a template, and sent to HeyGen placed in the frame", async () => {
    const req = videoRequestSchema.parse({
      title: "Open house",
      avatarId: STOCK_AVATARS[0].id,
      voiceId: STOCK_VOICES[0].id,
      aspect: "9:16",
      resolution: "720p",
      scenes: [
        { script: "Welcome in.", background: { type: "color", value: "#0f172a" }, overlay: { text: "12 Maple Street", position: "top" } },
        { script: "Priced to sell.", background: { type: "color", value: "#0f172a" }, overlay: { text: "$450,000", position: "bottom", size: "large", color: "#facc15" } },
        { script: "See you there.", background: { type: "color", value: "#0f172a" }, overlay: { text: " " } },
      ],
    });
    const video = await createVideo(req, "agent");
    assert.deepEqual(video.scenes?.map((sc) => sc.overlay), [{ text: "12 Maple Street" }, { text: "$450,000", position: "bottom", size: "large", color: "#facc15" }, undefined]);
    const template = await createTemplate({ fromVideoId: video.id }, "agent");
    assert.deepEqual(template.scenes[1].overlay, video.scenes![1].overlay, "a template keeps the text");
    assert.deepEqual(templateInputSchema.parse({ title: "T", scenes: [{ script: "Hi.", background: { type: "color", value: "#fff" }, overlay: { text: "Hello", size: "small" } }] }).scenes![0].overlay, { text: "Hello", size: "small" });

    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    let sent: { video_inputs: Array<{ text?: Record<string, unknown> }> } | null = null;
    (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    await heygen.createVideo(video, { ...STOCK_AVATARS[0], provider: "heygen", source: "provider" as const }, { ...STOCK_VOICES[0], provider: "heygen" });
    // A 720p portrait frame is 720 x 1280: text is centred across it, sized from its shorter side.
    assert.deepEqual(sent!.video_inputs[0].text, { type: "text", text: "12 Maple Street", font_family: "Arial", font_size: 47, font_weight: "bold", color: "#ffffff", position: { x: 360, y: 154 }, text_align: "center", line_height: 1.2 });
    assert.deepEqual(sent!.video_inputs[1].text, sceneText({ text: "$450,000", position: "bottom", size: "large", color: "#facc15" }, { width: 720, height: 1280 }));
    assert.equal(sent!.video_inputs[1].text!.font_size, 65);
    assert.deepEqual(sent!.video_inputs[1].text!.position, { x: 360, y: 1050 });
    assert.equal("text" in sent!.video_inputs[2], false, "a scene without text sends none");
  });
});
