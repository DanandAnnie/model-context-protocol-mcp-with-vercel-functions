// A share link's start time (?t=) and the links the video page copies to a chapter.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStartTime, shareLinkAt } from "../share-time";

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
  });

  it("is no start for anything else: zero, a day or more, a repeated t, or a malformed clock", () => {
    for (const bad of [undefined, null, "", "0", "0s", "-5", "1.2345", "abc", "1:75", "1:60", "1:5", "90:00", "1m30", "1h30", "1e3", "0x10", "s", "h", "1:2:3:4", "86400", "24h", "24:00:00", ["1", "2"], 5]) {
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
