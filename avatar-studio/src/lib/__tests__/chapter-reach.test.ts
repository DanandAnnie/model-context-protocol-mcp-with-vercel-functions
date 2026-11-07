// Chapter reach: share-page viewers who played each chapter, counted by the scene it opens.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createVideo, getVideo, recordChapterView, updateVideo, videoPatchSchema, videoRequestSchema, watchSchema } from "../services";
import { videoChapters } from "../chapters";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const bg = { type: "color" as const, value: "#0f172a" };
const OWNER = "user_reach";

async function madeTour(): Promise<Video> {
  const v = await createVideo(
    videoRequestSchema.parse({
      title: "Tour",
      avatarId: STOCK_AVATARS[0].id,
      voiceId: STOCK_VOICES[0].id,
      scenes: [
        { script: "Welcome to twelve Maple Street, a bright family home with room for everyone.", background: bg },
        { script: "[pause 3s]", background: bg },
        { script: "The kitchen was redone last spring with quartz counters and a big island.", background: bg },
      ],
    }),
    OWNER,
  );
  const stored = await getVideo(v.id, OWNER, false);
  globalThis.__avatarStudioStore!.put("video", { ...stored, status: "completed", durationSec: 30 });
  return getVideo(v.id, OWNER, false);
}

describe("recordChapterView", () => {
  it("counts a viewer once per chapter, by the scene it opens, and only scenes the share page lists", async () => {
    const v = await madeTour();
    assert.deepEqual(videoChapters(v).map((c) => c.scene), [0, 2], "the silent scene is no chapter");
    const seen = new Set<number>();
    const viewer = (scene: number) => () => (seen.has(scene) ? false : (seen.add(scene), true));
    assert.deepEqual(await recordChapterView(v.id, 0, viewer(0)), { counted: true });
    assert.deepEqual(await recordChapterView(v.id, 0, viewer(0)), { counted: false }, "the same viewer again");
    assert.deepEqual(await recordChapterView(v.id, 2, viewer(2)), { counted: true });
    assert.equal((await recordChapterView(v.id, 1)).counted, false, "a silent scene is no chapter");
    assert.equal((await recordChapterView(v.id, 7)).counted, false, "a scene the video does not have");
    assert.equal(seen.has(1) || seen.has(7), false);
    assert.deepEqual((await getVideo(v.id, OWNER, false)).chapterViews, { "0": 1, "2": 1 });
  });

  it("counts nothing before the render completes, and answers an offline link as not found", async () => {
    const v = await createVideo(
      videoRequestSchema.parse({
        title: "Tour",
        avatarId: STOCK_AVATARS[0].id,
        voiceId: STOCK_VOICES[0].id,
        scenes: [
          { script: "Welcome to the house.", background: bg },
          { script: "The kitchen comes next.", background: bg },
        ],
      }),
      OWNER,
    );
    assert.deepEqual(await recordChapterView(v.id, 0), { counted: false });
    const made = await madeTour();
    await updateVideo(made.id, videoPatchSchema.parse({ sharePassword: "letmein1" }), OWNER);
    assert.equal((await recordChapterView(made.id, 0)).counted, false, "a locked link needs the unlock cookie");
    await updateVideo(made.id, videoPatchSchema.parse({ sharePassword: null, shareDisabled: true }), OWNER);
    await assert.rejects(recordChapterView(made.id, 0), /not found/);
    await assert.rejects(recordChapterView("vid_missing", 0), /not found/);
  });

  it("keeps the counts through a rename, an edit, and beacons landing together", async () => {
    const v = await madeTour();
    const burst = await Promise.all([
      recordChapterView(v.id, 0),
      recordChapterView(v.id, 2),
      updateVideo(v.id, videoPatchSchema.parse({ sceneNames: { "3": "The kitchen" } }), OWNER),
      recordChapterView(v.id, 0),
      updateVideo(v.id, videoPatchSchema.parse({ title: "Maple Street" }), OWNER),
    ]);
    assert.equal(burst.length, 5);
    const after = await getVideo(v.id, OWNER, false);
    assert.deepEqual(after.chapterViews, { "0": 2, "2": 1 }, "every concurrent beacon landed, and the edits kept them");
    assert.equal(after.scenes![2].name, "The kitchen");
    assert.equal(after.title, "Maple Street");
    // A named silent scene becomes a chapter, and from then on counts.
    await updateVideo(v.id, videoPatchSchema.parse({ sceneNames: { "2": "A look around" } }), OWNER);
    assert.equal((await recordChapterView(v.id, 1)).counted, true);
  });
});

describe("recordChapterView, chapters close together", () => {
  it("does not count a scene starting within the same second as the chapter before, which is no chapter", async () => {
    const v = await createVideo(
      videoRequestSchema.parse({
        title: "Quick",
        avatarId: STOCK_AVATARS[0].id,
        voiceId: STOCK_VOICES[0].id,
        scenes: [
          { script: "A.", background: bg },
          { script: "B.", background: bg },
          { script: "C.", background: bg },
        ],
      }),
      OWNER,
    );
    const stored = await getVideo(v.id, OWNER, false);
    globalThis.__avatarStudioStore!.put("video", { ...stored, status: "completed", durationSec: 2 });
    const made = await getVideo(v.id, OWNER, false);
    assert.deepEqual(videoChapters(made).map((c) => c.scene), [0, 2]);
    assert.equal((await recordChapterView(v.id, 1)).counted, false);
    assert.equal((await recordChapterView(v.id, 2)).counted, true);
  });
});

describe("watchSchema", () => {
  it("takes a quarter or a scene number, and nothing else", () => {
    assert.deepEqual(watchSchema.parse({ quarter: 50 }), { quarter: 50 });
    assert.deepEqual(watchSchema.parse({ scene: 2 }), { scene: 2 });
    for (const bad of [{ scene: -1 }, { scene: 20 }, { scene: 1.5 }, { scene: "2" }, { quarter: 30 }, {}]) {
      assert.throws(() => watchSchema.parse(bad), Error, JSON.stringify(bad));
    }
  });
});

describe("chaptersPlayed", () => {
  const chapters = [
    { startMs: 0, scene: 0 },
    { startMs: 6_000, scene: 2 },
    { startMs: 6_300, scene: 3 },
    { startMs: 9_000, scene: 4 },
    { startMs: 20_000, scene: 5 },
  ];
  const clip = 12_000;

  it("counts a chapter once the playhead moves on within it, not on the first update after a seek", async () => {
    const { chaptersPlayed } = await import("../chapter-play");
    const first = chaptersPlayed(chapters, clip, null, 9_100);
    assert.deepEqual(first, { mark: { scene: 4, ms: 9_100 }, played: [] }, "landing in a chapter is not playing it");
    assert.deepEqual(chaptersPlayed(chapters, clip, first.mark, 9_350).played, [4]);
    assert.deepEqual(chaptersPlayed(chapters, clip, first.mark, 9_100).played, [], "a playhead that has not moved");
    assert.deepEqual(chaptersPlayed(chapters, clip, { scene: 4, ms: 9_500 }, 1_000).played, [], "backwards (a loop's restart) is no play");
  });

  it("counts a chapter run through into the next, however short, and every one a sparse update skipped", async () => {
    const { chaptersPlayed } = await import("../chapter-play");
    assert.deepEqual(chaptersPlayed(chapters, clip, { scene: 2, ms: 6_100 }, 6_400).played, [2], "the 0.3 s chapter, seen once");
    assert.deepEqual(chaptersPlayed(chapters, clip, { scene: 0, ms: 5_900 }, 9_200).played, [0, 2, 3]);
  });

  it("leaves out a chapter timed past the clip's end, and a list of fewer than two", async () => {
    const { chaptersPlayed } = await import("../chapter-play");
    assert.equal(chaptersPlayed(chapters, clip, { scene: 4, ms: 11_000 }, 11_600).mark?.scene, 4);
    assert.deepEqual(chaptersPlayed(chapters, 5_000, { scene: 0, ms: 1_000 }, 1_300), { mark: null, played: [] }, "one chapter left is no list");
    assert.deepEqual(chaptersPlayed(chapters, clip, { scene: 5, ms: 20_100 }, 20_400).played, [], "a mark the page does not list");
  });
});
