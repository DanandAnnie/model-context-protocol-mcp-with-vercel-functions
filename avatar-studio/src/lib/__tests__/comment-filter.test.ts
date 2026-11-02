// Narrowing a video's open comments in a workspace to those naming the reader, or those they wrote in.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterThreads, repliesByThread } from "../comment-list";
import type { VideoComment } from "../types";

const me = "u-me";
const note = (id: string, authorId: string, extra: Partial<VideoComment> = {}) => ({ id, authorId, createdAt: `2026-11-02T10:0${id.length}:00Z`, ...extra });
const threads = [
  note("a", "u-ann", { mentions: [{ userId: me, email: "me@example.com" }] }),
  note("b", "u-ann"),
  note("c", me),
  note("d", "u-bob"),
  note("e", "u-bob", { mentions: [{ userId: "u-ann", email: "ann@example.com" }] }),
];
const replies = repliesByThread([
  note("b1", me, { parentId: "b" }),
  note("d1", "u-ann", { parentId: "d", mentions: [{ userId: me, email: "me@example.com" }] }),
]);
const ids = (list: Array<{ id: string }>) => list.map((c) => c.id);

describe("filterThreads", () => {
  it("keeps the threads whose note or a reply names the reader, in the order given", () => {
    assert.deepEqual(ids(filterThreads(threads, replies, "mentions", me)), ["a", "d"]);
  });

  it("keeps the threads whose note or a reply the reader wrote", () => {
    assert.deepEqual(ids(filterThreads(threads, replies, "mine", me)), ["b", "c"]);
  });

  it("keeps every thread for all, or when the reader is not known", () => {
    assert.deepEqual(ids(filterThreads(threads, replies, "all", me)), ["a", "b", "c", "d", "e"]);
    assert.deepEqual(ids(filterThreads(threads, replies, "mentions")), ["a", "b", "c", "d", "e"]);
    assert.deepEqual(filterThreads([], replies, "mine", me), []);
  });
});
