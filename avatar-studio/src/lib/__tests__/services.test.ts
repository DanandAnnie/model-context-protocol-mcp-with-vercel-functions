// Service-layer tests against the demo providers and the in-memory store.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import {
  createAvatar,
  createAvatarSchema,
  createTranslation,
  createVideo,
  deleteVideo,
  getVideo,
  listAvatars,
  listVideos,
  scriptSchema,
  videoRequestSchema,
} from "../services";
import { MockAvatarProvider } from "../providers/avatar/mock";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { SCRIPT_TEMPLATES, findTemplate } from "../templates";

beforeEach(() => {
  // Fresh store per test; getStore() memoises on globalThis.
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("avatars", () => {
  it("lists stock avatars in demo mode", async () => {
    const avatars = await listAvatars();
    assert.equal(avatars.length, STOCK_AVATARS.length);
    assert.ok(avatars.every((a) => a.imageUrl.startsWith("data:image/svg+xml")));
  });

  it("creates a custom avatar and lists it first", async () => {
    const created = await createAvatar({ name: "Dan", imageUrl: "https://example.com/p.jpg" });
    assert.equal(created.source, "custom");
    const avatars = await listAvatars();
    assert.equal(avatars[0].id, created.id);
  });

  it("rejects non-image inputs", () => {
    assert.throws(() => createAvatarSchema.parse({ name: "x", imageUrl: "not a url" }));
    assert.doesNotThrow(() => createAvatarSchema.parse({ name: "x", imageUrl: "data:image/png;base64,AAAA" }));
  });
});

describe("videos", () => {
  const base = {
    title: "Test",
    script: "Hello there. This is a short test script for the renderer.",
    avatarId: STOCK_AVATARS[0].id,
    voiceId: STOCK_VOICES[0].id,
  };

  it("applies schema defaults", () => {
    const parsed = videoRequestSchema.parse(base);
    assert.equal(parsed.aspect, "16:9");
    assert.equal(parsed.captions, false);
    assert.equal(parsed.speed, 1);
    assert.deepEqual(parsed.background, { type: "color", value: "#f1f5f9" });
  });

  it("submits a render, records names, and reports processing", async () => {
    const video = await createVideo(videoRequestSchema.parse(base));
    assert.equal(video.status, "processing");
    assert.equal(video.provider, "mock");
    assert.equal(video.avatarName, STOCK_AVATARS[0].name);
    assert.equal(video.voiceName, STOCK_VOICES[0].name);
    assert.ok(video.providerJobId?.startsWith("mock_"));
    const again = await getVideo(video.id);
    assert.equal(again.status, "processing");
  });

  it("completes once the mock render window has elapsed", async () => {
    const video = await createVideo(videoRequestSchema.parse(base));
    // Rewind the embedded start time so the mock provider reports completion.
    const [, , duration] = video.providerJobId!.split("_");
    await globalThis.__avatarStudioStore!.put("video", { ...video, providerJobId: `mock_${Date.now() - 60_000}_${duration}` });
    const done = await getVideo(video.id);
    assert.equal(done.status, "completed");
    assert.ok(done.videoUrl);
    assert.equal(done.durationSec, Number(duration));
  });

  it("fails cleanly for an unknown avatar", async () => {
    await assert.rejects(createVideo(videoRequestSchema.parse({ ...base, avatarId: "nope" })), /not found/);
  });

  it("lists newest first and deletes", async () => {
    const a = await createVideo(videoRequestSchema.parse({ ...base, title: "A" }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await createVideo(videoRequestSchema.parse({ ...base, title: "B" }));
    const list = await listVideos();
    assert.deepEqual(list.map((v) => v.id), [b.id, a.id]);
    await deleteVideo(a.id);
    assert.equal((await listVideos()).length, 1);
    await assert.rejects(deleteVideo(a.id), /not found/);
  });

  it("estimates duration from script length and speed", async () => {
    const provider = new MockAvatarProvider();
    const words = Array.from({ length: 50 }, () => "word").join(" ");
    const slow = await provider.createVideo({ ...base, script: words, aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 0.5 });
    const fast = await provider.createVideo({ ...base, script: words, aspect: "16:9", background: { type: "color", value: "#fff" }, captions: false, speed: 1.5 });
    assert.equal(Number(slow.providerJobId.split("_")[2]), 40);
    assert.equal(Number(fast.providerJobId.split("_")[2]), 13);
  });
});

describe("translations and scripts", () => {
  it("creates a translation job", async () => {
    const t = await createTranslation({ title: "Dub", sourceVideoUrl: "https://example.com/v.mp4", targetLanguage: "Spanish" });
    assert.equal(t.status, "processing");
    assert.equal(t.targetLanguage, "Spanish");
  });

  it("validates script writer input", () => {
    const parsed = scriptSchema.parse({ topic: "welcoming tenants" });
    assert.equal(parsed.tone, "friendly");
    assert.equal(parsed.lengthSec, 45);
    assert.throws(() => scriptSchema.parse({ topic: "hi", lengthSec: 5 }));
  });
});

describe("templates", () => {
  it("have unique ids and non-empty scripts", () => {
    const ids = new Set(SCRIPT_TEMPLATES.map((t) => t.id));
    assert.equal(ids.size, SCRIPT_TEMPLATES.length);
    assert.ok(SCRIPT_TEMPLATES.every((t) => t.script.trim().length > 40));
    assert.equal(findTemplate("listing-walkthrough")?.aspect, "9:16");
    assert.equal(findTemplate("missing"), undefined);
  });
});

describe("captions", () => {
  it("times cues proportionally and covers the full duration", async () => {
    const { buildCues, buildSrt, formatSrtTime } = await import("../captions");
    const cues = buildCues("One two three. Four five six seven eight nine.", 9);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].startMs, 0);
    assert.equal(cues[0].endMs, 3000);
    assert.equal(cues[1].endMs, 9000);
    assert.equal(formatSrtTime(3_723_456), "01:02:03,456");
    const srt = buildSrt("Hello there. Welcome!", 4);
    assert.match(srt, /^1\n00:00:00,000 --> 00:00:0\d,\d{3}\nHello there\.\n\n2\n/);
  });

  it("returns nothing for empty input", async () => {
    const { buildCues } = await import("../captions");
    assert.deepEqual(buildCues("   ", 10), []);
    assert.deepEqual(buildCues("Hi.", 0), []);
  });
});

describe("auth", () => {
  it("is open without a password and validates tokens with one", async () => {
    const { authEnabled, isValidSession, sessionToken, timingSafeEqual } = await import("../auth");
    delete process.env.STUDIO_PASSWORD;
    assert.equal(authEnabled(), false);
    assert.equal(await isValidSession(undefined), true);
    process.env.STUDIO_PASSWORD = "hunter2";
    assert.equal(authEnabled(), true);
    assert.equal(await isValidSession(undefined), false);
    assert.equal(await isValidSession("wrong"), false);
    assert.equal(await isValidSession(await sessionToken("hunter2")), true);
    assert.notEqual(await sessionToken("hunter2"), await sessionToken("hunter3"));
    assert.equal(timingSafeEqual("abc", "abd"), false);
    delete process.env.STUDIO_PASSWORD;
  });
});
