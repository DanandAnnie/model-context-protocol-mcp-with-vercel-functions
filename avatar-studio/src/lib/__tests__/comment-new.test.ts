// Comments written since this browser last opened a video's page.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NOTHING_SEEN, commentsSeenKey, hasNewComments, newSince, seenMark } from "../comment-list";
import { openCommentsBadge } from "../client";

const notes = [
  { id: "old", createdAt: "2026-11-01T10:00:00.000Z" },
  { id: "same", createdAt: "2026-11-02T09:00:00.000Z" },
  { id: "later", createdAt: "2026-11-02T09:00:00.001Z" },
  { id: "reply", createdAt: "2026-11-03T09:00:00.000Z", parentId: "old" },
  { id: "mine", createdAt: "2026-11-03T10:00:00.000Z", mine: true },
];

describe("newSince", () => {
  it("names what someone else wrote after the mark, leaving out the reader's own", () => {
    assert.deepEqual([...newSince(notes, "2026-11-02T09:00:00.000Z")], ["later", "reply"]);
    assert.deepEqual([...newSince(notes, "2026-10-01T00:00:00.000Z")], ["old", "same", "later", "reply"]);
    assert.deepEqual([...newSince(notes, "2026-11-04T00:00:00.000Z")], []);
  });

  it("finds nothing new on a first visit, or with a mark it cannot read", () => {
    assert.equal(newSince(notes, null).size, 0);
    assert.equal(newSince(notes, "yesterday").size, 0);
    assert.equal(newSince([], "2026-11-02T09:00:00.000Z").size, 0);
  });
});

describe("seenMark", () => {
  it("keeps when the newest someone else wrote was written, passing over the reader's own", () => {
    assert.equal(seenMark(notes), "2026-11-03T09:00:00.000Z");
    // A teammate's note stamped just before the reader's own, but saved after the page loaded, is still new next time.
    const late = { id: "late", createdAt: "2026-11-03T09:59:59.000Z" };
    assert.deepEqual([...newSince([...notes, late], seenMark(notes))], ["late"]);
  });

  it("keeps a mark from before any comment when there are none, or only the reader's own", () => {
    assert.equal(seenMark([]), NOTHING_SEEN);
    assert.equal(seenMark([{ createdAt: "2026-11-03T10:00:00.000Z", mine: true }]), NOTHING_SEEN);
    // So whatever someone writes later is new, whatever the browser's clock says.
    assert.deepEqual([...newSince([{ id: "a", createdAt: "2026-11-03T10:00:00.000Z" }], NOTHING_SEEN)], ["a"]);
    // A comment whose time cannot be read is passed over.
    assert.equal(seenMark([{ createdAt: "soon" }, { createdAt: "2026-11-01T10:00:00.000Z" }]), "2026-11-01T10:00:00.000Z");
    assert.equal(seenMark([{ createdAt: "soon" }]), NOTHING_SEEN);
  });

  it("marks so that the comments shown are not new next time, and a later one is", () => {
    const mark = seenMark(notes);
    assert.equal(newSince(notes, mark).size, 0);
    assert.deepEqual([...newSince([...notes, { id: "next", createdAt: "2026-11-03T09:00:00.001Z" }], mark)], ["next"]);
  });
});

describe("commentsSeenKey", () => {
  it("keeps each reader's mark on each video apart", () => {
    assert.equal(commentsSeenKey("u1", "vid_a"), "avatar-studio:comments-seen:u1:vid_a");
    assert.notEqual(commentsSeenKey("u1", "vid_a"), commentsSeenKey("u2", "vid_a"));
    assert.notEqual(commentsSeenKey("u1", "vid_a"), commentsSeenKey("u1", "vid_b"));
  });
});

describe("hasNewComments", () => {
  it("is true when someone else wrote after the mark this browser kept, as the library's cards show", () => {
    assert.equal(hasNewComments("2026-11-03T10:00:00.001Z", "2026-11-03T10:00:00.000Z"), true);
    assert.equal(hasNewComments("2026-11-03T10:00:00.000Z", "2026-11-03T10:00:00.000Z"), false);
    assert.equal(hasNewComments("2026-11-03T09:00:00.000Z", "2026-11-03T10:00:00.000Z"), false);
    assert.equal(hasNewComments("2026-11-03T09:00:00.000Z", NOTHING_SEEN), true, "seen with no comments, so the first one is new");
  });

  it("is false for a video never opened here, with nothing written by others, or with a time it cannot read", () => {
    assert.equal(hasNewComments("2026-11-03T10:00:00.000Z", null), false);
    assert.equal(hasNewComments(undefined, "2026-11-03T10:00:00.000Z"), false);
    assert.equal(hasNewComments("soon", "2026-11-03T10:00:00.000Z"), false);
    assert.equal(hasNewComments("2026-11-03T10:00:00.000Z", "yesterday"), false);
  });

  it("is said by the card's badge", () => {
    assert.equal(openCommentsBadge(2, 0, true).label, "2 open comments; new since you last opened it");
    assert.equal(openCommentsBadge(2, 1, true).label, "2 open comments, 1 mentions you; new since you last opened it");
    assert.equal(openCommentsBadge(1).label, "1 open comment");
  });
});
