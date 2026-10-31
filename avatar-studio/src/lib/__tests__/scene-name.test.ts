// Scene names: what a scene is called on its editor tab and in its chapter's title, kept by templates and copies.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createTemplate, createVideo, templateInputSchema, videoRequestSchema } from "../services";
import { videoChapters } from "../chapters";
import { copiedScene, parseCopiedScene } from "../scene-clipboard";
import { mergeScenes, splitParagraphs, splitScene } from "../scene-split";
import { sceneName } from "../scene-text";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Scene, Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const bg = { type: "color" as const, value: "#0f172a" };
const request = (scenes: Array<Record<string, unknown>>) =>
  videoRequestSchema.safeParse({ title: "Tour", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, scenes });

describe("sceneName", () => {
  it("collapses spaces, and a blank or non-text name is none", () => {
    assert.equal(sceneName("  The   kitchen "), "The kitchen");
    assert.equal(sceneName("   "), undefined);
    assert.equal(sceneName(42), undefined);
    assert.equal(sceneName(undefined), undefined);
  });
  it("cuts a long name to 40 characters as a reader counts them, never inside an emoji", () => {
    assert.equal(sceneName("x".repeat(50)), "x".repeat(40));
    assert.equal(sceneName(`${"x".repeat(39)}👍🏽 more`), `${"x".repeat(39)}👍🏽`);
    // Fifteen flags are fifteen characters, though each is four code units.
    assert.equal(sceneName("🇳🇴".repeat(15)), "🇳🇴".repeat(15));
    assert.equal(sceneName("🇳🇴".repeat(45)), "🇳🇴".repeat(40));
  });
});

describe("a video's scene names", () => {
  it("are stored collapsed, a blank one as absent, and one over 40 characters refused", async () => {
    const parsed = request([
      { name: "  The   kitchen ", script: "The kitchen.", background: bg },
      { name: "   ", script: "The garden.", background: bg },
    ]);
    assert.equal(parsed.success, true);
    const scenes = parsed.success ? parsed.data.scenes! : [];
    assert.equal(scenes[0].name, "The kitchen");
    assert.equal("name" in scenes[1] && scenes[1].name !== undefined, false);
    const long = request([{ name: "x".repeat(41), script: "Hi.", background: bg }, { script: "Bye.", background: bg }]);
    assert.equal(long.success, false);
    assert.deepEqual(long.success ? [] : long.error.issues[0].path, ["scenes", 0, "name"]);
    assert.equal(request([{ name: "🇳🇴".repeat(15), script: "Hi.", background: bg }, { script: "Bye.", background: bg }]).success, true);
    assert.match(long.success ? "" : long.error.issues[0].message, /40 characters or fewer/);
    const video = await createVideo(parsed.success ? parsed.data : (undefined as never), "user_names");
    assert.equal(video.scenes![0].name, "The kitchen");
    assert.equal(video.scenes![1].name, undefined);
  });

  it("are kept by a template made from the video and by one spelled out", async () => {
    const parsed = request([
      { name: "Kitchen", script: "The kitchen.", background: bg },
      { script: "The garden.", background: bg },
    ]);
    const video = await createVideo(parsed.success ? parsed.data : (undefined as never), "user_names");
    const fromVideo = await createTemplate(templateInputSchema.parse({ fromVideoId: video.id }), "user_names");
    assert.deepEqual(fromVideo.scenes.map((sc) => sc.name), ["Kitchen", undefined]);
    const spelled = await createTemplate(
      templateInputSchema.parse({ title: "Tour", scenes: [{ name: " Pricing ", script: "Priced to sell.", background: bg }] }),
      "user_names",
    );
    assert.equal(spelled.scenes[0].name, "Pricing");
  });
});

describe("chapters", () => {
  const video = (scenes: Scene[]): Video => ({
    id: "vid_names",
    title: "Tour",
    script: scenes.map((s) => s.script).join("\n\n"),
    scenes,
    avatarId: "stock_1",
    voiceId: "stock_voice_1",
    aspect: "16:9",
    background: bg,
    captions: false,
    speed: 1,
    status: "completed",
    videoUrl: "https://cdn.example/tour.mp4",
    durationSec: 30,
    provider: "mock",
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
  });
  it("take a scene's name before its on-screen text and its words", () => {
    const titles = videoChapters(
      video([
        { name: "Welcome", script: "Hello and welcome to the house.", background: bg, overlay: { text: "12 Elm Street" } },
        { script: "The kitchen was redone last spring.", background: bg, overlay: { text: "Kitchen" } },
        { script: "The garden faces south.", background: bg },
      ]),
    ).map((c) => c.title);
    assert.deepEqual(titles, ["Welcome", "Kitchen", "The garden faces south."]);
  });
  it("count a named silent scene as a chapter of its own", () => {
    const titles = videoChapters(
      video([
        { script: "Hello and welcome to the house, with three bedrooms.", background: bg },
        { name: "A look around", script: "[pause 5s]", background: bg },
        { script: "Call me to see it this week.", background: bg },
      ]),
    ).map((c) => c.title);
    assert.deepEqual(titles, ["Hello and welcome to the house, with three bedrooms.", "A look around", "Call me to see it this week."]);
    const unnamed = videoChapters(
      video([
        { script: "Hello and welcome to the house, with three bedrooms.", background: bg },
        { script: "[pause 5s]", background: bg },
        { script: "Call me to see it this week.", background: bg },
      ]),
    );
    assert.equal(unnamed.length, 2);
  });
});

describe("copies, splits, and merges", () => {
  const named: Scene = { name: "Kitchen", script: "The kitchen. It was redone.\n\nNew cabinets too.", background: bg };
  it("a copied scene keeps its name, cleaned up", () => {
    assert.equal(parseCopiedScene(JSON.stringify(copiedScene("ws_1", named)))!.scene.name, "Kitchen");
    assert.equal(parseCopiedScene(JSON.stringify({ space: "ws_1", scene: { ...named, name: "  Big   kitchen " } }))!.scene.name, "Big kitchen");
    assert.equal(parseCopiedScene(JSON.stringify({ space: "ws_1", scene: { ...named, name: 7 } }))!.scene.name, undefined);
  });
  it("a split keeps the name on the first part only", () => {
    const [a, b] = splitScene(named, named.script.indexOf(" It"))!;
    assert.equal(a.name, "Kitchen");
    assert.equal(b.name, undefined);
    const parts = splitParagraphs(named)!;
    assert.deepEqual(parts.map((p) => p.name), ["Kitchen", undefined]);
  });
  it("a merge keeps the first name, or the second's when the first has none, and says when one goes", () => {
    const other: Scene = { name: "Garden", script: "The garden.", background: bg };
    const both = mergeScenes(named, other)!;
    assert.equal(both.scene.name, "Kitchen");
    assert.deepEqual(both.lost, ["name"]);
    const second = mergeScenes({ script: "Hello.", background: bg }, other)!;
    assert.equal(second.scene.name, "Garden");
    assert.deepEqual(second.lost, []);
    // A name of only spaces is none, and names differing only in spaces are the same, as the editor keeps them as typed.
    assert.equal(mergeScenes({ name: "   ", script: "Hello.", background: bg }, other)!.scene.name, "Garden");
    const spaced = mergeScenes({ name: " Garden  ", script: "Hello.", background: bg }, other)!;
    assert.equal(spaced.scene.name, "Garden");
    assert.deepEqual(spaced.lost, []);
  });
});
