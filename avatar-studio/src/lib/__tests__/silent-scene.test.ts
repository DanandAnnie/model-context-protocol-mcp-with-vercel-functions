// A scene of only pauses is a silent one: the presenter holds without a word. What is accepted, what HeyGen
// receives, and how the captions and the demo render time it.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { captionCuesFor, createVideo, subtitleCues, templateInputSchema, videoRequestSchema } from "../services";
import { silentSeconds } from "../pauses";
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

  it("last a second to a minute, to a tenth, take no speed, and bind no audio scene's transcript", async () => {
    assert.equal(silentSeconds("[pause 0.1s] [pause 0.2s] [pause 1s]"), 1.3, "summed to a tenth, not 1.3000000000000003");
    assert.match(issues(videoRequestSchema.safeParse(request("Hello.", "[pause 0.5s]"))), /lasts at least 1 second/);
    // What an audio clip says is only for captions and search, so its pauses are not a silent scene's.
    const clip = { ...request("Hello."), scenes: [...request("Hello.").scenes, { script: "[pause 10s] ".repeat(7), background: bg, audioId: "clip_1" }] };
    assert.ok(videoRequestSchema.safeParse(clip).success);
    const paced = videoRequestSchema.parse({ ...request("Hello there.", "[pause 3s]"), scenes: [{ script: "Hello there.", background: bg }, { script: "[pause 3s]", background: bg, speed: 0.75 }] });
    const video = await createVideo(paced, "holder");
    assert.equal(video.scenes?.[1].speed, undefined, "a silent scene has no pace to keep");
    assert.match(issues(templateInputSchema.safeParse({ title: "T", scenes: [{ script: "Hi.", background: bg }, { script: "[pause 10s] ".repeat(7), background: bg }] })), /at most 60 seconds/);
  });

  it("keep their share in a translated track whether or not the translation kept the pause", () => {
    const scenes = [{ script: "Hello there." }, { script: "[pause 3s]" }, { script: "Goodbye now." }];
    const video = { script: scenes.map((sc) => sc.script).join("\n\n"), speed: 1, durationSec: 5, scenes };
    const kept = subtitleCues(video, "Hola.\n\n[pause 3s]\n\nAdiós.");
    const dropped = subtitleCues(video, "Hola.\n\nAdiós.");
    assert.deepEqual(dropped, kept);
    assert.deepEqual(kept.map((c) => c.text), ["Hola.", "Adiós."]);
    assert.ok(kept[1].startMs > 4000, `the closing line waits out the silence (starts at ${kept[1].startMs} ms)`);
  });
});
