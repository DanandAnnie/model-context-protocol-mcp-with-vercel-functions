// Marks along the video for the comments pinned to a moment.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commentMarkers } from "../comment-list";

describe("commentMarkers", () => {
  it("places each pinned thread along the video, earliest first, leaving out the notes on the whole video", () => {
    const marks = commentMarkers([{ id: "a", atSec: 30 }, { id: "b" }, { id: "c", atSec: 0 }, { id: "d", atSec: 15 }], 60);
    assert.deepEqual(marks, [
      { fromSec: 0, toSec: 0, pct: 0, ids: ["c"] },
      { fromSec: 15, toSec: 15, pct: 25, ids: ["d"] },
      { fromSec: 30, toSec: 30, pct: 50, ids: ["a"] },
    ]);
    assert.deepEqual(commentMarkers([{ id: "b" }], 60), []);
    assert.deepEqual(commentMarkers([], 60), []);
  });

  it("puts threads at the same moment, or too close to press apart, on one mark at the earliest", () => {
    // 2% of 600 s is 12 s: 100 and 110 share a mark, and 113 starts the next one, which 120 joins.
    const marks = commentMarkers([{ id: "a", atSec: 110 }, { id: "b", atSec: 100 }, { id: "c", atSec: 100 }, { id: "d", atSec: 113 }, { id: "e", atSec: 120 }], 600);
    assert.deepEqual(marks.map((m) => [m.fromSec, m.toSec, m.ids]), [
      [100, 110, ["b", "c", "a"]],
      [113, 120, ["d", "e"]],
    ]);
    // A mark is measured from its first moment, so a run of close moments does not grow into one long mark.
    assert.deepEqual(commentMarkers([{ id: "a", atSec: 0 }, { id: "b", atSec: 1 }, { id: "c", atSec: 2 }, { id: "d", atSec: 3 }], 100).map((m) => m.ids), [["a", "b"], ["c", "d"]]);
    // A gap of zero keeps every moment apart that is not the same.
    assert.deepEqual(commentMarkers([{ id: "a", atSec: 1 }, { id: "b", atSec: 1.5 }, { id: "c", atSec: 1 }], 100, 0).map((m) => m.ids), [["a", "c"], ["b"]]);
  });

  it("keeps a moment past the end at the end, and places nothing without a length", () => {
    assert.deepEqual(commentMarkers([{ id: "a", atSec: 90 }], 60), [{ fromSec: 90, toSec: 90, pct: 100, ids: ["a"] }]);
    for (const length of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.deepEqual(commentMarkers([{ id: "a", atSec: 1 }], length), []);
  });

  it("leaves the list given as it was", () => {
    const threads = [{ id: "a", atSec: 9 }, { id: "b", atSec: 1 }];
    commentMarkers(threads, 10);
    assert.deepEqual(threads.map((c) => c.id), ["a", "b"]);
  });
});
