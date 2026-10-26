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
    // Each spoken scene's first caption line begins at its chapter; the silent scene without on-screen text has none.
    assert.equal(chapters.length, 3);
    chapters.forEach((c, i) => assert.ok(cues.some((cue) => cue.startMs === c.startMs), `chapter ${i + 1}`));
    assert.equal(chapters[2].startMs, bounds[3].startMs);
  });

  it("is titled from the on-screen text, else the words (cut at a word), else what the scene is", () => {
    assert.deepEqual(
      videoChapters(tour).map((c) => c.title),
      ["12 Maple Street", "The kitchen was redone last spring with quartz counters, new…", "Call Dana to book a showing this weekend."],
    );
    const clip = video([{ script: "Hello.", background: bg }, { script: " ", background: bg, audioId: "clip_1", audioSeconds: 4 }]);
    assert.equal(videoChapters(clip)[1].title, "Scene 2");
    assert.deepEqual(videoChapters(video([{ script: "Only one scene.", background: bg }])), [], "one scene has no chapters");
  });

  it("follow captions an editor corrected, in time and in words, and never share a second", () => {
    const edited = video(
      [
        { script: "Hi, I'm Dana Smith.", background: bg },
        { script: "Call me on 555 0100 today.", background: bg },
      ],
      { durationSec: 20, captionCues: [{ startMs: 0, endMs: 14_000, text: "Hi, I'm Dana." }, { startMs: 15_000, endMs: 20_000, text: "Call the office today." }] },
    );
    assert.deepEqual(videoChapters(edited), [
      { startMs: 0, title: "Hi, I'm Dana." },
      { startMs: 15_000, title: "Call the office today." },
    ]);
    // A silent scene keeps its own start and title when the captions are corrected, and the scene after it keeps its
    // own; a scene whose lines were all removed keeps its estimate rather than borrowing a neighbour's line.
    const withPause = video(
      [
        { script: "Welcome to twelve Maple Street.", background: bg, overlay: { text: "12 Maple Street" } },
        { script: "The kitchen was redone last spring.", background: bg },
        { script: "[pause 2s]", background: bg, overlay: { text: "Take a look" } },
        { script: "Call Dana today to book a showing.", background: bg },
      ],
      { durationSec: 8 },
    );
    const plain = videoChapters(withPause);
    const auto = captionCuesFor(withPause).cues.map((c, i) => (i === 1 ? { ...c, text: c.text.replace("redone", "remodeled") } : c));
    const fixed = videoChapters({ ...withPause, captionCues: auto });
    assert.deepEqual(fixed.map((c) => c.startMs), plain.map((c) => c.startMs));
    assert.deepEqual(fixed.map((c) => c.title), ["12 Maple Street", "The kitchen was remodeled last spring.", "Take a look", "Call Dana today to book a showing."]);
    const removed = videoChapters({ ...withPause, captionCues: auto.filter((_, i) => i !== 1) });
    assert.deepEqual(removed.map((c) => [c.startMs, c.title]), plain.map((c, i) => [c.startMs, i === 1 ? "The kitchen was redone last spring." : c.title]));
    // A silent scene without on-screen text is no chapter, unless it opens the video.
    const opens = video([{ script: "[pause 2s]", background: bg }, { script: "Hello there, and welcome.", background: bg }], { durationSec: 6 });
    assert.deepEqual(videoChapters(opens).map((c) => c.title), ["Opening", "Hello there, and welcome."]);
    // Scenes less than a second apart keep only the first.
    const quick = video([{ script: "A.", background: bg }, { script: "B.", background: bg }, { script: "C.", background: bg }], { durationSec: 2 });
    assert.deepEqual(videoChapters(quick).map((c) => [c.startMs, c.title]), [[0, "A."], [1333, "C."]]);
  });

  it("cuts long titles at whole characters and keeps a word that fits", () => {
    const title = (script: string) => videoChapters(video([{ script: "Hi.", background: bg }, { script, background: bg }]))[1].title;
    const sixty = `${"abcd ".repeat(11)}abcd`.padEnd(60, "x"); // exactly 60 characters
    assert.equal(sixty.length, 60);
    assert.equal(title(sixty), sixty, "a title of 60 characters is whole");
    // Character 61 is a space, so the last word fits and is kept.
    assert.equal(title(`${sixty} more words`), `${sixty}…`);
    // A word running past the limit is left out whole.
    assert.equal(title(`${"abcd ".repeat(11)}abcdefghijkl more`), `${"abcd ".repeat(10)}abcd…`);
    const emoji = `${"a".repeat(59)}😀 and more`;
    assert.equal(videoChapters(video([{ script: "Hi.", background: bg }, { script: emoji, background: bg }]))[1].title, `${"a".repeat(59)}😀…`);
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
    // Judged on the whole seconds it copies: 0:00, 0:10, 0:20 is ten seconds apart.
    assert.equal(youtubeReadsChapters([{ startMs: 0, title: "A" }, { startMs: 10_400, title: "B" }, { startMs: 20_300, title: "C" }], 31_000), true);
  });

  it("reaches the share page for a rendered video of several scenes only", () => {
    assert.equal(shareBodyFor(tour, null).chapters?.length, 3);
    assert.equal(shareBodyFor({ ...tour, status: "processing", videoUrl: undefined }, null).chapters, undefined, "not before it renders");
    assert.equal(shareBodyFor(video([{ script: "Just one.", background: bg }]), null).chapters, undefined);
  });
});
