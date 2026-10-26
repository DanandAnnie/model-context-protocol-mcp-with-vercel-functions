// A scene of only pauses is a silent one: the presenter holds without a word. What is accepted, what HeyGen
// receives, and how the captions and the demo render time it.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { captionCuesFor, createVideo, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const bg = { type: "color" as const, value: "#ffffff" };
const request = (...scripts: string[]) => ({ title: "Hold", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, scenes: scripts.map((script) => ({ script, background: bg })) });
const issues = (r: { success: boolean; error?: { issues: unknown } }) => JSON.stringify(r.error?.issues ?? []);

describe("silent scenes", () => {
  it("are accepted beside spoken ones, up to a minute, but a video needs some words", () => {
    assert.ok(videoRequestSchema.safeParse(request("Welcome to the open house.", "[pause 3s]")).success);
    assert.match(issues(videoRequestSchema.safeParse(request("[pause 3s]", "[pause]"))), /needs some words, not only pauses: every scene is silent/);
    assert.match(issues(videoRequestSchema.safeParse(request("Hello.", "[pause 10s] ".repeat(7)))), /silent scene \(only pauses\) lasts at most 60 seconds/);
    assert.ok(videoRequestSchema.safeParse(request("Hello.", "[pause 10s] ".repeat(6))).success, "exactly a minute is fine");
  });

  it("hold the presenter on HeyGen, leave no caption, and last their length in the demo render", async () => {
    const req = videoRequestSchema.parse(request("Hello there.", "[pause 3s]", "Goodbye now."));
    const { HeyGenAvatarProvider } = await import("../providers/avatar/heygen");
    const heygen = new HeyGenAvatarProvider("key");
    let sent: { video_inputs: Array<{ voice: Record<string, unknown> }> } | null = null;
    (heygen as unknown as { client: Record<string, (...a: unknown[]) => Promise<unknown>> }).client.generateVideo = async (b) => {
      sent = b as typeof sent;
      return { video_id: "hg_1" };
    };
    await heygen.createVideo(req, { ...STOCK_AVATARS[0], provider: "heygen", source: "provider" as const }, { ...STOCK_VOICES[0], provider: "heygen" });
    assert.deepEqual(sent!.video_inputs[1].voice, { type: "silence", duration: 3 });
    assert.equal(sent!.video_inputs[0].voice.type, "text");

    // Two words, three seconds of silence, two words: 0.8 + 3 + 0.8 seconds, rounded to 5 by the estimate.
    const video = await createVideo(req, "holder");
    assert.equal(Number(video.providerJobId?.split("_")[2]), 5, "the demo render lasts as long, silence included");
    const { cues } = captionCuesFor({ script: video.script, speed: 1, scenes: video.scenes });
    assert.deepEqual(cues.map((c) => c.text), ["Hello there.", "Goodbye now."], "the silence has no line");
    assert.ok(cues[1].startMs >= 4000, `the closing line waits out the silence (starts at ${cues[1].startMs} ms)`);
  });
});
