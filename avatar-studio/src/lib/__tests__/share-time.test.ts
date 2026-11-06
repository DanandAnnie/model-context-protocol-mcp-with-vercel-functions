// A share link's start time (?t=) and the links the video page copies to a chapter.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chapterSectionPlays, clockTime, parseEndTime, parseStartTime, parseTimeInput, shareChapterLink, shareLinkAt, shareSectionLink } from "../share-time";

describe("parseStartTime", () => {
  it("reads seconds (to the millisecond), units, and clock times", () => {
    assert.equal(parseStartTime("90"), 90);
    assert.equal(parseStartTime("90s"), 90);
    assert.equal(parseStartTime("12.4"), 12.4);
    assert.equal(parseStartTime("12.405s"), 12.405);
    assert.equal(parseStartTime("1m30s"), 90);
    assert.equal(parseStartTime("1M30S"), 90, "any case");
    assert.equal(parseStartTime("2m"), 120);
    assert.equal(parseStartTime("1h2m3s"), 3723);
    assert.equal(parseStartTime("1:30"), 90);
    assert.equal(parseStartTime("01:02:03"), 3723);
    assert.equal(parseStartTime(" 45 "), 45);
    assert.equal(parseStartTime("1:05.5"), 65.5, "a clock to the tenth, as the section fields write it");
    assert.equal(parseStartTime("90:00"), 5400, "minutes past an hour, as a long video's description writes them");
    assert.equal(parseStartTime("75:30.5"), 4530.5);
    assert.equal(parseStartTime("60:00"), 3600);
    assert.equal(parseStartTime("1439:59.999"), 86399.999, "just under a day");
  });

  it("is no start for anything else: zero, a day or more, a repeated t, or a malformed clock", () => {
    for (const bad of [undefined, null, "", "0", "0s", "-5", "1.2345", "abc", "1:75", "1:60", "1:5", "1:90:00", "1440:00", ":30", "75:3", "75:30.1234", "1:2:3", "0:75:30", "1::30", "30:", "1m30", "1h30", "1e3", "0x10", "s", "h", "1:2:3:4", "86400", "24h", "24:00:00", ["1", "2"], 5]) {
      assert.equal(parseStartTime(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe("shareLinkAt", () => {
  const base = "https://studio.test/share/vid_1";

  it("starts just inside the chapter: rounded up to a tenth, whole seconds plain, nothing at the start", () => {
    assert.equal(shareLinkAt(base, 12_400), `${base}?t=12.4`);
    assert.equal(shareLinkAt(base, 12_430), `${base}?t=12.5`);
    assert.equal(shareLinkAt(base, 61_000), `${base}?t=61`);
    assert.equal(shareLinkAt(base, 0), base);
    assert.equal(parseStartTime(new URL(shareLinkAt(base, 12_430)).searchParams.get("t"))! * 1000 >= 12_430, true, "never before the chapter");
  });

  it("keeps the millisecond when rounding would reach the next chapter, and joins a base that has a query", () => {
    assert.equal(shareLinkAt(base, 12_950, 13_000), `${base}?t=12.95`);
    assert.equal(shareLinkAt(`${base}?embed=1`, 5_000), `${base}?embed=1&t=5`);
  });
});

describe("share links that play a section", () => {
  const base = "https://studio.test/share/vid_1";
  it("reads an end at least a second after the start, in the same forms", () => {
    assert.equal(parseEndTime("1:30"), 90);
    assert.equal(parseEndTime("90", 60), 90);
    assert.equal(parseEndTime("61", 60), 61);
    assert.equal(parseEndTime("1m", undefined), 60);
    for (const [raw, start] of [["60.5", 60], ["60", 60], ["30", 60], ["abc", undefined], ["0", undefined], [["90", "91"], undefined], ["0.5", undefined]] as const) {
      assert.equal(parseEndTime(raw, start), undefined, JSON.stringify([raw, start]));
    }
  });

  it("writes the section link: start and end to the millisecond at most, a start of 0 left out, a non-end left off", () => {
    assert.equal(shareSectionLink(base, 65, 90), `${base}?t=65&end=90`);
    assert.equal(shareSectionLink(base, 0, 30), `${base}?end=30`);
    assert.equal(shareSectionLink(base, 12.4567, 20.25), `${base}?t=12.457&end=20.25`);
    assert.equal(shareSectionLink(base, 65), `${base}?t=65`);
    assert.equal(shareSectionLink(base, 65, 65.5), `${base}?t=65`, "an end under a second after the start is no end");
    assert.equal(shareSectionLink(base, 0), base);
    assert.equal(shareSectionLink(`${base}?x=1`, 5, 10), `${base}?x=1&t=5&end=10`);
    // What it writes, the share page reads back.
    const url = new URL(shareSectionLink(base, 65.5, 92.3));
    const start = parseStartTime(url.searchParams.get("t"));
    assert.deepEqual([start, parseEndTime(url.searchParams.get("end"), start)], [65.5, 92.3]);
  });

  it("shows times as a clock to the tenth, and reads typed times with zero as the beginning", () => {
    assert.deepEqual([clockTime(0), clockTime(5), clockTime(65), clockTime(65.46), clockTime(3723), clockTime(59.96)], ["0:00", "0:05", "1:05", "1:05.5", "1:02:03", "1:00"]);
    assert.deepEqual(["0", "0:00", "00:00", "0s", "0.0", "1:05", "65", "1m5s", "1:05.5"].map(parseTimeInput), [0, 0, 0, 0, 0, 65, 65, 65, 65.5]);
    for (const t of [0, 5, 65, 65.4, 3723]) assert.equal(parseTimeInput(clockTime(t)), t, `round trip ${t}`);
    assert.equal(parseTimeInput("soon"), undefined);
  });
});

describe("shareChapterLink", () => {
  const base = "https://studio.test/share/vid_1";
  it("plays one chapter: from its start as its own link starts, to the next chapter's start exactly", () => {
    assert.equal(shareChapterLink(base, 0, 12_340), `${base}?end=12.34`);
    assert.equal(shareChapterLink(base, 12_340, 30_000), `${base}?t=12.4&end=30`);
    assert.equal(shareChapterLink(base, 12_341, 17_400), `${base}?t=12.4&end=17.4`);
    const start = new URL(shareLinkAt(base, 12_340, 30_000)).searchParams.get("t");
    assert.equal(new URL(shareChapterLink(base, 12_340, 30_000)).searchParams.get("t"), start, "the same start as the chapter's own link");
    // A chapter under a second long is no section: its plain start link.
    assert.equal(shareChapterLink(base, 5_000, 5_800), `${base}?t=5`);
  });
  it("says which chapters get a section, as the link itself decides", () => {
    assert.equal(chapterSectionPlays(0, 12_340), true);
    assert.equal(chapterSectionPlays(5_000, 5_800), false);
    assert.equal(chapterSectionPlays(5_000, 6_000), true);
    // The start rounds up to a tenth, so 1.0 s of chapter from 5.05 s is 0.95 s of link: no section.
    assert.equal(chapterSectionPlays(5_050, 6_050), false);
    for (const [a, b] of [[0, 999], [0, 1000], [12_340, 13_400], [12_341, 13_400], [12_399, 13_399], [7_777, 9_000]]) {
      assert.equal(chapterSectionPlays(a, b), new URL(shareChapterLink(base, a, b)).searchParams.has("end"), `${a} to ${b}`);
    }
  });
});
