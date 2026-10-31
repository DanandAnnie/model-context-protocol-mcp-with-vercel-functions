// Retitling a made video's chapters: scene names, set after the render through PATCH /api/videos/:id.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createVideo, getVideo, updateVideo, videoPatchSchema, videoRequestSchema } from "../services";
import { sceneChapters, videoChapters } from "../chapters";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const bg = { type: "color" as const, value: "#0f172a" };
const make = (scenes: Array<Record<string, unknown>>) =>
  createVideo(videoRequestSchema.parse({ title: "Tour", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, scenes }), "user_titles");
const rename = (id: string, sceneNames: Record<string, string | null>, extra: Record<string, unknown> = {}) =>
  updateVideo(id, videoPatchSchema.parse({ sceneNames, ...extra }), "user_titles");

describe("sceneNames", () => {
  it("names the scenes given by number, a null or blank one clearing its name, the others kept", async () => {
    const v = await make([
      { name: "Hello", script: "Welcome to twelve Maple Street, a bright family home.", background: bg },
      { script: "The kitchen was redone last spring with quartz counters.", background: bg },
      { name: "Call", script: "Call Dana to book a showing.", background: bg },
    ]);
    const next = await rename(v.id, { "1": null, "2": "  The   kitchen " });
    assert.deepEqual(next.scenes!.map((sc) => sc.name), [undefined, "The kitchen", "Call"]);
    assert.equal("name" in next.scenes![0], false);
    // The scripts and everything else about the scenes stay as they were.
    assert.deepEqual(next.scenes!.map((sc) => sc.script), v.scenes!.map((sc) => sc.script));
    assert.deepEqual(videoChapters(next).map((c) => c.title), ["Welcome to twelve Maple Street, a bright family home.", "The kitchen", "Call"]);
    assert.deepEqual((await rename(v.id, { "3": "" })).scenes!.map((sc) => sc.name), [undefined, "The kitchen", undefined]);
  });

  it("refuses a scene the video does not have, or a video of one scene, before writing anything", async () => {
    const v = await make([
      { script: "One.", background: bg },
      { script: "Two.", background: bg },
    ]);
    await assert.rejects(rename(v.id, { "3": "Three" }), /has 2 scenes, so it has no scene 3/);
    // Nothing else in the request (here the cover) is written when the names are refused.
    await assert.rejects(rename(v.id, { "3": "Three" }, { cover: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }));
    assert.equal((await getVideo(v.id, "user_titles")).cover, undefined);
    const lone = await make([{ script: "Just one scene.", background: bg }]);
    await assert.rejects(rename(lone.id, { "1": "Name" }), /two scenes or more/);
    for (const bad of [{}, { "0": "x" }, { one: "x" }, { "1": "x".repeat(41) }]) assert.equal(videoPatchSchema.safeParse({ sceneNames: bad }).success, false, JSON.stringify(bad));
  });

  it("is a change to the share page, so an approval does not outlive a new name, but does outlive the same one", async () => {
    const v = await make([
      { name: "Intro", script: "One.", background: bg },
      { script: "Two.", background: bg },
    ]);
    const store = globalThis.__avatarStudioStore!;
    const stored = (await store.get<Video>("video", v.id))!;
    const at = new Date().toISOString();
    await store.put<Video>("video", { ...stored, review: { status: "approved", requestedById: "user_titles", requestedAt: at, decidedAt: at } });
    assert.equal((await rename(v.id, { "1": "Intro", "2": null })).review?.status, "approved");
    assert.equal((await rename(v.id, { "2": "Outro" })).review, undefined);
  });

  it("puts the names on the scenes as stored when it writes, keeping a name another request set meanwhile", async () => {
    const v = await make([
      { script: "One.", background: bg },
      { script: "Two.", background: bg },
    ]);
    await Promise.all([rename(v.id, { "1": "First" }), rename(v.id, { "2": "Second" })]);
    assert.deepEqual((await getVideo(v.id, "user_titles")).scenes!.map((sc) => sc.name), ["First", "Second"]);
  });

  it("is kept when another edit that read the video before it lands after it", async () => {
    const v = await make([
      { script: "One.", background: bg },
      { script: "Two.", background: bg },
    ]);
    // Setting a password hashes it between the read and the write, so the rename lands in between.
    await Promise.all([updateVideo(v.id, videoPatchSchema.parse({ sharePassword: "open sesame" }), "user_titles"), rename(v.id, { "2": "Kitchen" })]);
    const stored = await getVideo(v.id, "user_titles");
    assert.equal(stored.shareLocked, true);
    assert.deepEqual(stored.scenes!.map((sc) => sc.name), [undefined, "Kitchen"]);
    assert.equal(videoPatchSchema.safeParse({ sceneNames: { "21": "x" } }).success, false);
  });
});

describe("sceneChapters", () => {
  it("gives each scene's chapter as its name would leave it, or null for a scene that is no chapter", () => {
    const video = {
      script: "",
      durationSec: 30,
      speed: 1,
      provider: "mock" as const,
      scenes: [
        { name: "Welcome", script: "Hello there, and welcome to the house.", speed: undefined, audioSeconds: undefined },
        { name: "A pause", script: "[pause 3s]", speed: undefined, audioSeconds: undefined },
        { script: "Call me.", speed: undefined, audioSeconds: undefined, audioId: "clip_1" },
      ],
    };
    assert.deepEqual(sceneChapters(video).map((c) => c?.title ?? null), ["Welcome", "A pause", "Call me."]);
    assert.deepEqual(sceneChapters(video, { ignoreNames: true }).map((c) => c?.title ?? null), ["Hello there, and welcome to the house.", null, "Call me."]);
  });
});
