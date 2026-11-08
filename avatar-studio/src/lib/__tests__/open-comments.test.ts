// The library's open-comment counts and filter: unresolved notes per video, and the videos that have any.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { addComment, createVideo, filterVideos, openCommentCounts, queryVideos, resolveComment, deleteVideo, videoQuerySchema, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const make = (title: string, owner = "ws_team") =>
  createVideo(videoRequestSchema.parse({ title, script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), owner);

describe("open comments in the library", () => {
  it("counts only the notes no one has resolved, per video and per owner", async () => {
    const a = await make("A");
    const b = await make("B");
    const other = await make("Other", "ws_other");
    await addComment(a.id, { text: "one" }, "ws_team");
    const two = await addComment(a.id, { text: "two" }, "ws_team");
    const done = await addComment(b.id, { text: "done" }, "ws_team");
    await addComment(other.id, { text: "elsewhere" }, "ws_other");
    await resolveComment(b.id, done.id, true, "ws_team");
    assert.deepEqual(Object.fromEntries(await openCommentCounts("ws_team")), { [a.id]: 2 });
    await resolveComment(a.id, two.id, true, "ws_team");
    assert.deepEqual(Object.fromEntries(await openCommentCounts("ws_team")), { [a.id]: 1 });
    assert.deepEqual(Object.fromEntries(await openCommentCounts("ws_other")), { [other.id]: 1 });
  });

  it("filters to the videos with open notes and reports their counts on the page", async () => {
    const a = await make("Qx alpha");
    const b = await make("Qx bravo");
    await addComment(a.id, { text: "fix the intro" }, "ws_team");
    const every = await queryVideos("ws_team", videoQuerySchema.parse({}));
    assert.equal(every.matched, 2);
    assert.deepEqual(every.openComments, { [a.id]: 1 }, "only videos with open notes are listed");
    const open = await queryVideos("ws_team", videoQuerySchema.parse({ comments: "open" }));
    assert.deepEqual(open.videos.map((v) => v.id), [a.id]);
    assert.equal(open.total, 2, "the library total is not narrowed");
    // Two videos made in the same moment sort in either order, so the page is picked by its search instead.
    const onlyB = await queryVideos("ws_team", videoQuerySchema.parse({ q: "qx bravo" }));
    assert.deepEqual(onlyB.videos.map((v) => v.id), [b.id]);
    assert.deepEqual(onlyB.openComments, {}, "counts are for the page's videos only");
    await addComment(b.id, { text: "and here" }, "ws_team");
    const paged = await queryVideos("ws_team", videoQuerySchema.parse({ limit: "1", comments: "open" }));
    assert.equal(paged.matched, 2);
    assert.equal(Object.keys(paged.openComments).length, 1, "only the page's video is counted, not every match");
    assert.deepEqual(Object.keys(paged.openComments), paged.videos.map((v) => v.id));
    assert.equal(videoQuerySchema.safeParse({ comments: "resolved" }).success, false);
  });

  it("filters by the counts it is given", async () => {
    const a = await make("A");
    const query = videoQuerySchema.parse({ comments: "open" });
    assert.deepEqual(filterVideos([a], query, new Map([[a.id, 1]])).map((v) => v.id), [a.id]);
    assert.deepEqual(filterVideos([a], query, new Map()), []);
    assert.deepEqual(filterVideos([a], videoQuerySchema.parse({})).map((v) => v.id), [a.id], "with no filter, no counts are needed");
    assert.throws(() => filterVideos([a], query), /needs the counts/, "asked for without them, it fails rather than match nothing");
  });

  it("counts and filters the trash too", async () => {
    const a = await make("Qx trashed");
    await make("Qx kept");
    await addComment(a.id, { text: "before it went" }, "ws_team");
    await deleteVideo(a.id, "ws_team");
    const trash = await queryVideos("ws_team", videoQuerySchema.parse({ trash: "1", comments: "open" }));
    assert.deepEqual(trash.videos.map((v) => v.id), [a.id]);
    assert.deepEqual(trash.openComments, { [a.id]: 1 });
    const library = await queryVideos("ws_team", videoQuerySchema.parse({ comments: "open" }));
    assert.deepEqual(library.videos, [], "a trashed video is not in the library's view");
  });
});
