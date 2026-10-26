// A speaking speed per scene: what is stored, what HeyGen receives, and how long the demo render and captions run.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { captionCuesFor, captionDurationSec, createTemplate, createVideo, subtitleCues, transcriptsFor, videoRequestSchema } from "../services";
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
    assert.deepEqual(video.scenes?.map((sc) => sc.speed), [0.5, 1, undefined], "a scene's chosen speed is kept, even one equal to the video's");
    // A lone scene's speed is the video's.
    const lone = videoRequestSchema.parse({ ...req, speed: 1, scenes: [{ script: ten, background: bg, speed: 0.8 }] });
    assert.equal(lone.speed, 0.8);
    assert.equal(lone.scenes?.[0].speed, undefined);
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

  it("times each scene's captions within its share of the running time, a slow scene's lines staying on longer", () => {
    // Ten words at half speed take 8 s, ten at full speed 4 s, and a 6-second clip 6 s: 18 s in all.
    const scenes = [{ script: ten, speed: 0.5 }, { script: ten }, { script: "Said on the clip.", audioSeconds: 6 }];
    const video = { script: scenes.map((sc) => sc.script).join("\n\n"), speed: 1, scenes };
    assert.equal(captionDurationSec(video), 18, "a clip counts for its own length");
    const { cues } = captionCuesFor(video);
    assert.deepEqual(cues.map((c) => [c.startMs, c.endMs]), [[0, 8000], [8000, 12000], [12000, 18000]]);
    // A rendered length is shared the same way.
    assert.deepEqual(captionCuesFor({ ...video, durationSec: 36 }).cues.map((c) => c.startMs), [0, 16000, 24000]);
    // A translation with a paragraph per scene keeps the scenes' timing; any other shape is timed over the whole.
    assert.deepEqual(subtitleCues(video, "Uno.\n\nDos.\n\nTres.").map((c) => c.startMs), [0, 8000, 12000]);
    assert.deepEqual(subtitleCues(video, "Uno. Dos.").map((c) => c.startMs), [0, 9000]);
    assert.deepEqual(transcriptsFor({ ...video, subtitles: { Spanish: "Uno.\n\nDos.\n\nTres." } })[1].cues.map((c) => c.endMs), [8000, 12000, 18000]);
  });

  it("weighs scenes written without spaces by their length, and times D-ID, blank lines, and pauses as spoken", () => {
    const join = (scenes: Array<{ script: string }>) => scenes.map((sc) => sc.script).join("\n\n");
    // 144 Chinese characters say about 72 words' worth, the closing thanks about 2.5: the thanks gets the last second or so.
    const zh = [{ script: "我们的新产品今天正式发布。".repeat(12).slice(0, 144) }, { script: "谢谢大家。" }];
    const zhCues = captionCuesFor({ script: join(zh), speed: 1, durationSec: 40, scenes: zh }).cues;
    assert.ok(zhCues[zhCues.length - 1].startMs > 38_000, `the closing thanks starts at ${zhCues[zhCues.length - 1].startMs} ms`);
    // D-ID speaks at the voice's natural pace whatever the scenes ask, so its scenes share the time by their words.
    const paced = [{ script: ten, speed: 0.5 }, { script: ten }];
    assert.deepEqual(captionCuesFor({ script: join(paced), speed: 1, durationSec: 8, scenes: paced, provider: "did" }).cues.map((c) => c.startMs), [0, 4000]);
    assert.deepEqual(captionCuesFor({ script: join(paced), speed: 1, durationSec: 12, scenes: paced, provider: "heygen" }).cues.map((c) => c.startMs), [0, 8000]);
    // A scene holding a blank line still lines up with its translation, paragraph for paragraph.
    const twoParts = [{ script: "Part one.\n\nPart two.", speed: 0.5 }, { script: "The end." }];
    const video = { script: join(twoParts), speed: 1, durationSec: 12, scenes: twoParts };
    assert.deepEqual(subtitleCues(video, "Uno.\n\nDos.\n\nFin.").map((c) => c.startMs), captionCuesFor(video).cues.map((c) => c.startMs));
    // A short line before a long pause leaves the screen when it has been said, not halfway through the pause.
    const pausing = [{ script: "Welcome. [pause 2s]" }, { script: ten }];
    const [welcome, next] = captionCuesFor({ script: join(pausing), speed: 1, scenes: pausing }).cues;
    assert.ok(welcome.endMs <= 300, `"Welcome." ends at ${welcome.endMs} ms`);
    assert.equal(next.startMs, 2250);
  });
});
