// A speaking speed per scene: what is stored, what HeyGen receives, and how long the demo render and captions run.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { captionDurationSec, createTemplate, createVideo, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const bg = { type: "color" as const, value: "#ffffff" };
const ten = "one two three four five six seven eight nine ten";

describe("per-scene speed", () => {
  it("is stored when it differs from the video's, and HeyGen speaks each scene at its own", async () => {
    const req = videoRequestSchema.parse({
      title: "Paced",
      avatarId: STOCK_AVATARS[0].id,
      voiceId: STOCK_VOICES[0].id,
      speed: 1,
      scenes: [
        { script: ten, background: bg, speed: 0.5 },
        { script: ten, background: bg, speed: 1 },
        { script: ten, background: bg },
      ],
    });
    const video = await createVideo(req, "pacer");
    assert.deepEqual(video.scenes?.map((sc) => sc.speed), [0.5, undefined, undefined], "a speed equal to the video's says nothing of its own");
    // The demo render runs as long as each scene takes at its pace: 10 words at 2.5 a second, halved, then twice at full speed.
    assert.equal(video.durationSec ?? Number(video.providerJobId?.split("_")[2]), 16);
    assert.equal(captionDurationSec({ script: video.script, speed: 1, scenes: video.scenes }), 16, "captions are timed the same way until the render reports its length");
    const template = await createTemplate({ fromVideoId: video.id }, "pacer");
    assert.equal(template.scenes[0].speed, 0.5, "a template keeps a scene's pace");

    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    let sent: { video_inputs: Array<{ voice: { speed?: number } }> } | null = null;
    (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    const ava = { ...STOCK_AVATARS[0], provider: "heygen", source: "provider" as const };
    const voice = { ...STOCK_VOICES[0], provider: "heygen" };
    await heygen.createVideo(req, ava, voice);
    assert.deepEqual(sent!.video_inputs.map((i) => i.voice.speed), [0.5, 1, 1]);
    assert.throws(() => videoRequestSchema.parse({ ...req, scenes: [{ script: "Hi.", background: bg, speed: 2 }] }));
  });
});
