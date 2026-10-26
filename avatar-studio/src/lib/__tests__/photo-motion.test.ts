// Photo avatar motion: how much a photo avatar's face moves (expressiveness) and its gestures in words (HeyGen's v3
// motion prompt, Avatar IV). What is accepted, stored, kept, and sent, and to which presenters.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createTemplate, createVideo, templateInputSchema, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Avatar } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const base = { title: "Tour", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Welcome in." };

describe("photo avatar motion", () => {
  it("keeps only what differs from HeyGen's default, as one line within its limit", () => {
    assert.equal(videoRequestSchema.parse({ ...base, expressiveness: "low" }).expressiveness, undefined, "low is the default, stored as absent");
    assert.equal(videoRequestSchema.parse({ ...base, expressiveness: "high" }).expressiveness, "high");
    assert.equal(videoRequestSchema.safeParse({ ...base, expressiveness: "wild" }).success, false);
    assert.equal(videoRequestSchema.parse({ ...base, motionPrompt: "  Nods warmly,\n  then  waves " }).motionPrompt, "Nods warmly, then waves");
    assert.equal(videoRequestSchema.parse({ ...base, motionPrompt: "   " }).motionPrompt, undefined, "blank is none");
    assert.match(JSON.stringify(videoRequestSchema.safeParse({ ...base, motionPrompt: "x".repeat(301) }).error?.issues), /at most 300 characters/);
    assert.ok(videoRequestSchema.safeParse({ ...base, motionPrompt: `${"x".repeat(300)}${" ".repeat(500)}` }).success, "spaces collapsed before the length counts");
    assert.equal(templateInputSchema.parse({ title: "T", scenes: [{ script: "Hi.", background: { type: "color", value: "#fff" } }], expressiveness: "medium" }).expressiveness, "medium");
  });

  it("is stored with the video and kept by a template", async () => {
    const video = await createVideo(videoRequestSchema.parse({ ...base, expressiveness: "medium", motionPrompt: "Gestures toward the room" }), "mover");
    assert.deepEqual([video.expressiveness, video.motionPrompt], ["medium", "Gestures toward the room"]);
    const plain = await createVideo(videoRequestSchema.parse(base), "mover");
    assert.equal("expressiveness" in plain || "motionPrompt" in plain, false);
    const template = await createTemplate({ fromVideoId: video.id }, "mover");
    assert.deepEqual([template.expressiveness, template.motionPrompt], ["medium", "Gestures toward the room"]);
  });

  it("reaches HeyGen for scenes whose presenter is a photo avatar, and no others", async () => {
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    let sent: { scenes: Array<{ type: string; input?: Record<string, unknown> }> } | null = null;
    (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    const studio: Avatar = { ...STOCK_AVATARS[0], id: "look_studio", provider: "heygen", source: "provider" };
    const photoLook: Avatar = { ...STOCK_AVATARS[1], id: "look_photo", provider: "heygen", source: "provider", tags: ["photo avatar"] };
    const portrait: Avatar = { id: "av_mine", name: "Dana", imageUrl: "data:image/png;base64,AA==", source: "custom", provider: "heygen", providerAssetIds: { "heygen:look": "look_mine", "heygen:pending": "" } };
    const voice = { ...STOCK_VOICES[0], provider: "heygen" };
    const req = videoRequestSchema.parse({
      title: "Cast",
      avatarId: studio.id,
      voiceId: voice.id,
      expressiveness: "high",
      motionPrompt: "Nods and smiles",
      scenes: [
        { script: "A studio avatar.", background: { type: "color", value: "#000000" } },
        { script: "A photo look.", background: { type: "color", value: "#000000" }, avatarId: photoLook.id },
        { script: "An uploaded portrait.", background: { type: "color", value: "#000000" }, avatarId: portrait.id },
        { script: "Just the view.", background: { type: "image", value: "https://cdn.example.com/view.jpg" }, hidePresenter: true },
      ],
    });
    await heygen.createVideo(req, studio, voice, { avatars: { [studio.id]: studio, [photoLook.id]: photoLook, [portrait.id]: portrait }, voices: { [voice.id]: voice } });
    const inputs = sent!.scenes.map((sc) => sc.input ?? {});
    assert.deepEqual(inputs.map((i) => [i.expressiveness, i.motion_prompt]), [
      [undefined, undefined],
      ["high", "Nods and smiles"],
      ["high", "Nods and smiles"],
      [undefined, undefined],
    ], "a video avatar on Avatar IV takes neither; HeyGen refuses a motion prompt for one");
    assert.equal(inputs[2].avatar_id, "look_mine");
  });
});
