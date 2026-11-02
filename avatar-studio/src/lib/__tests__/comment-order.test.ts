// The order a video's open comments are listed in: as written, or by their moment in the video.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commentOrderFrom, orderThreads } from "../comment-list";

const notes = [
  { id: "a", atSec: 42 },
  { id: "b" },
  { id: "c", atSec: 3.5 },
  { id: "d", atSec: 42 },
  { id: "e" },
  { id: "f", atSec: 0 },
];
const ids = (list: Array<{ id: string }>) => list.map((c) => c.id);

describe("orderThreads", () => {
  it("keeps the order written, or lists pinned notes by moment and then the notes on the whole video", () => {
    assert.deepEqual(ids(orderThreads(notes, "written")), ["a", "b", "c", "d", "e", "f"]);
    // The start of the video (0) is a moment like any other; ties and unpinned notes keep the order written.
    assert.deepEqual(ids(orderThreads(notes, "moment")), ["f", "c", "a", "d", "b", "e"]);
    assert.deepEqual(ids(notes), ["a", "b", "c", "d", "e", "f"], "the list given is left as it was");
    assert.deepEqual(orderThreads([], "moment"), []);
  });

  it("reads back the order this browser kept, as written unless by moment was chosen", () => {
    assert.equal(commentOrderFrom("moment"), "moment");
    assert.equal(commentOrderFrom("written"), "written");
    assert.equal(commentOrderFrom(null), "written");
    assert.equal(commentOrderFrom("sideways"), "written");
  });
});
