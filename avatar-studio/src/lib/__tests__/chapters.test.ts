// Chapters: one per scene of a multi-scene video, starting where its captions do, titled from its on-screen text or
// its words, listed in the form a YouTube description reads, and on the share page once the video has rendered.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captionCuesFor } from "../services";
import { chaptersText, sceneBoundsMs, videoChapters, youtubeReadsChapters } from "../chapters";
import { shareBodyFor } from "../share-body";
import type { Video } from "../types";

const bg = { type: "color" as const, value: "#0f172a" };
const video = (scenes: Video["scenes"], extra: Partial<Video> = {}): Video => ({
  id: "vid_ch",
  title: "Tour",
  script: scenes!.map((s) => s.script).join("\n\n"),
  scenes,
  avatarId: "stock_1",
  voiceId: "stock_voice_1",
  aspect: "16:9",
  background: bg,
  captions: false,
  speed: 1,
  status: "completed",
  videoUrl: "https://cdn.example/tour.mp4",
  durationSec: 60,
  provider: "mock",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  ...extra,
});

describe("chapters", () => {
  const tour = video([
    { script: "Welcome to twelve Maple Street, a bright family home.", background: bg, overlay: { text: "12 Maple Street" } },
    { script: "The kitchen was redone last spring with quartz counters, new cabinets, and an island that seats four people comfortably.", background: bg },
    { script: "[pause 3s]", background: bg },
    { script: "Call Dana to book a showing this weekend.", background: bg },
  ]);

  it("starts each chapter where its scene's captions start, and the first at 0:00", () => {
    const chapters = videoChapters(tour);
    assert.equal(chapters[0].startMs, 0);
    const bounds = sceneBoundsMs(tour)!;
    assert.equal(bounds.at(-1)!.endMs, 60_000, "the last scene ends with the video");
    const cues = captionCuesFor(tour).cues;
    // Each spoken scene's first caption line begins at its chapter.
    for (const i of [0, 1, 3]) assert.ok(cues.some((c) => c.startMs === chapters[i].startMs), `scene ${i + 1}`);
  });

  it("is titled from the on-screen text, else the words (cut at a word), else what the scene is", () => {
    assert.deepEqual(
      videoChapters(tour).map((c) => c.title),
      ["12 Maple Street", "The kitchen was redone last spring with quartz counters…", "Pause", "Call Dana to book a showing this weekend."],
    );
    const clip = video([{ script: "Hello.", background: bg }, { script: " ", background: bg, audioId: "clip_1", audioSeconds: 4 }]);
    assert.equal(videoChapters(clip)[1].title, "Scene 2");
    assert.deepEqual(videoChapters(video([{ script: "Only one scene.", background: bg }])), [], "one scene has no chapters");
  });

  it("lists them as a YouTube description does, and knows when YouTube would show them", () => {
    const chapters = [
      { startMs: 0, title: "Welcome" },
      { startMs: 12_400, title: "Kitchen" },
      { startMs: 3_723_000, title: "Book a showing" },
    ];
    assert.equal(chaptersText(chapters), "0:00 Welcome\n0:12 Kitchen\n1:02:03 Book a showing");
    assert.equal(youtubeReadsChapters(chapters, 3_800_000), true);
    assert.equal(youtubeReadsChapters(chapters.slice(0, 2), 3_800_000), false, "fewer than three");
    assert.equal(youtubeReadsChapters(chapters, 3_729_000), false, "the last is shorter than ten seconds");
    assert.equal(youtubeReadsChapters([{ startMs: 0, title: "A" }, { startMs: 5_000, title: "B" }, { startMs: 30_000, title: "C" }], 60_000), false);
  });

  it("reaches the share page for a rendered video of several scenes only", () => {
    assert.equal(shareBodyFor(tour, null).chapters?.length, 4);
    assert.equal(shareBodyFor({ ...tour, status: "processing", videoUrl: undefined }, null).chapters, undefined, "not before it renders");
    assert.equal(shareBodyFor(video([{ script: "Just one.", background: bg }]), null).chapters, undefined);
  });
});
