// Replies to review notes: one level of threads, resolved and deleted with the note that starts them.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { addComment, commentSchema, createVideo, deleteComment, listComments, openCommentCounts, resolveComment, videoRequestSchema } from "../services";
import { repliesByThread, splitComments } from "../comment-list";
import { getStore } from "../store";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Video } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const ann = { id: "u-ann", email: "ann@example.com" };
const bob = { id: "u-bob" };
const make = (title = "Notes") => createVideo(videoRequestSchema.parse({ title, script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), "ws_team");

describe("comment replies", () => {
  it("answers a note that starts a thread, on the same video, without a moment of its own", async () => {
    const v = await make();
    const note = await addComment(v.id, { text: "Tighten the intro." }, "ws_team", ann);
    const reply = await addComment(v.id, commentSchema.parse({ text: "On it.", parentId: note.id }), "ws_team", bob);
    assert.equal(reply.parentId, note.id);
    await assert.rejects(addComment(v.id, { text: "Deeper", parentId: reply.id }, "ws_team", ann), /starts the thread/, "one level of replies");
    const other = await make("Other");
    await assert.rejects(addComment(other.id, { text: "Elsewhere", parentId: note.id }, "ws_team", ann), /not found/, "a note on another video");
    await assert.rejects(addComment(v.id, { text: "x", parentId: "cmt_missing" }, "ws_team", ann), /not found/);
    const stored = await getStore().get<Video>("video", v.id);
    await getStore().put("video", { ...stored!, status: "completed" });
    await assert.rejects(addComment(v.id, { text: "At 2s", parentId: note.id, atSec: 2 }, "ws_team", ann), /cannot be pinned/);
    assert.deepEqual((await listComments(v.id, "ws_team")).map((c) => c.text), ["Tighten the intro.", "On it."]);
  });

  it("is resolved with its thread, which counts once as open", async () => {
    const v = await make();
    const note = await addComment(v.id, { text: "Intro" }, "ws_team", ann);
    const reply = await addComment(v.id, { text: "Done?", parentId: note.id }, "ws_team", bob);
    await addComment(v.id, { text: "Yes", parentId: note.id }, "ws_team", ann);
    assert.deepEqual(Object.fromEntries(await openCommentCounts("ws_team")), { [v.id]: 1 }, "a thread counts once, however many replies");
    await assert.rejects(resolveComment(v.id, reply.id, true, "ws_team", bob), /starts the thread/);
    await resolveComment(v.id, note.id, true, "ws_team", bob);
    assert.deepEqual(Object.fromEntries(await openCommentCounts("ws_team")), {});
  });

  it("goes with the note it answers, whoever wrote it, but a reply deleted alone leaves the thread", async () => {
    const v = await make();
    const note = await addComment(v.id, { text: "Intro" }, "ws_team", ann);
    const mine = await addComment(v.id, { text: "Agreed", parentId: note.id }, "ws_team", ann);
    await addComment(v.id, { text: "Me too", parentId: note.id }, "ws_team", bob);
    const kept = await addComment(v.id, { text: "Another thread" }, "ws_team", bob);
    assert.deepEqual(await deleteComment(v.id, mine.id, "ws_team", ann), { replies: 0 });
    assert.equal((await listComments(v.id, "ws_team")).length, 3);
    await assert.rejects(deleteComment(v.id, note.id, "ws_team", bob), /Only the author/);
    assert.deepEqual(await deleteComment(v.id, note.id, "ws_team", ann), { replies: 1 }, "bob's reply goes with ann's note");
    assert.deepEqual((await listComments(v.id, "ws_team")).map((c) => c.id), [kept.id]);
  });
});

describe("replies and their thread changing meanwhile", () => {
  it("refuses a reply to a resolved thread until it is reopened", async () => {
    const v = await make();
    const note = await addComment(v.id, { text: "Intro" }, "ws_team", ann);
    await resolveComment(v.id, note.id, true, "ws_team", bob);
    await assert.rejects(addComment(v.id, { text: "Still not fixed", parentId: note.id }, "ws_team", ann), (e: Error) => e.name === "ConflictError" || /resolved; reopen it/.test(e.message));
    await resolveComment(v.id, note.id, false, "ws_team", bob);
    assert.equal((await addComment(v.id, { text: "Still not fixed", parentId: note.id }, "ws_team", ann)).parentId, note.id);
  });

  it("refuses to delete a thread answered since the caller looked, and deletes what they saw", async () => {
    const v = await make();
    const note = await addComment(v.id, { text: "Intro" }, "ws_team", ann);
    await addComment(v.id, { text: "Seen", parentId: note.id }, "ws_team", bob);
    await addComment(v.id, { text: "New", parentId: note.id }, "ws_team", bob);
    await assert.rejects(deleteComment(v.id, note.id, "ws_team", ann, 1), /a new reply since you looked/);
    assert.equal((await listComments(v.id, "ws_team")).length, 3, "nothing is deleted");
    assert.deepEqual(await deleteComment(v.id, note.id, "ws_team", ann, 2), { replies: 2 });
    assert.deepEqual(await listComments(v.id, "ws_team"), []);
  });

  it("takes back a reply whose thread was deleted while it was written", async () => {
    const v = await make();
    const note = await addComment(v.id, { text: "Intro" }, "ws_team", ann);
    const store = getStore();
    const put = store.put.bind(store);
    // ann deletes her note between this reply's check and its write.
    store.put = (async (kind: string, item: { parentId?: string }) => {
      if (kind === "comment" && item.parentId) await store.remove("comment", item.parentId);
      return put(kind as never, item as never);
    }) as typeof store.put;
    try {
      await assert.rejects(addComment(v.id, { text: "Too late", parentId: note.id }, "ws_team", bob), /was deleted/);
    } finally {
      store.put = put;
    }
    assert.deepEqual(await listComments(v.id, "ws_team"), [], "no reply is left without its note");
  });

  it("takes back a reply whose thread was resolved while it was written", async () => {
    const v = await make();
    const note = await addComment(v.id, { text: "Intro" }, "ws_team", ann);
    const store = getStore();
    const put = store.put.bind(store);
    // bob resolves the thread between this reply's check and its write.
    let raced = false;
    store.put = (async (kind: string, item: { parentId?: string }) => {
      if (kind === "comment" && item.parentId && !raced) {
        raced = true;
        store.put = put;
        await resolveComment(v.id, note.id, true, "ws_team", bob);
      }
      return put(kind as never, item as never);
    }) as typeof store.put;
    try {
      await assert.rejects(addComment(v.id, { text: "Too late", parentId: note.id }, "ws_team", ann), /resolved; reopen it/);
    } finally {
      store.put = put;
    }
    assert.deepEqual((await listComments(v.id, "ws_team")).map((c) => c.id), [note.id]);
  });

  it("deletes a reply that lands while its note is being deleted", async () => {
    const v = await make();
    const note = await addComment(v.id, { text: "Intro" }, "ws_team", ann);
    const store = getStore();
    const remove = store.remove.bind(store);
    // bob's reply is written just before ann's note goes, after her delete listed the replies.
    let raced = false;
    store.remove = (async (kind: string, id: string) => {
      if (kind === "comment" && id === note.id && !raced) {
        raced = true;
        await store.put("comment", { id: "cmt_late", ownerId: "ws_team", videoId: v.id, authorId: bob.id, text: "Late", parentId: note.id, createdAt: new Date().toISOString() });
      }
      return remove(kind as never, id);
    }) as typeof store.remove;
    try {
      assert.deepEqual(await deleteComment(v.id, note.id, "ws_team", ann, 0), { replies: 1 });
    } finally {
      store.remove = remove;
    }
    assert.deepEqual(await listComments(v.id, "ws_team"), [], "no reply is left without its note");
  });

  it("shows, counts, and lets anyone resolve a reply whose note is gone", async () => {
    const v = await make();
    const stray = { id: "cmt_stray", ownerId: "ws_team", videoId: v.id, authorId: bob.id, text: "Orphan", parentId: "cmt_gone", createdAt: new Date().toISOString() };
    await getStore().put("comment", stray);
    const { open } = splitComments(await listComments(v.id, "ws_team"));
    assert.deepEqual(open.map((c) => c.id), [stray.id], "listed on its own rather than hidden");
    assert.deepEqual(Object.fromEntries(await openCommentCounts("ws_team")), { [v.id]: 1 });
    await resolveComment(v.id, stray.id, true, "ws_team", ann);
    assert.deepEqual(Object.fromEntries(await openCommentCounts("ws_team")), {});
  });

  it("counts replies toward the comments a video can hold", async () => {
    const { MAX_COMMENTS_PER_VIDEO } = await import("../services/comments");
    const v = await make();
    const note = await addComment(v.id, { text: "Intro" }, "ws_team", ann);
    for (let i = 1; i < MAX_COMMENTS_PER_VIDEO; i++) await addComment(v.id, { text: `r${i}`, parentId: note.id }, "ws_team", bob);
    await assert.rejects(addComment(v.id, { text: "one more" }, "ws_team", ann), /At most/);
  });
});

describe("listing threads", () => {
  it("lists the notes that start threads, and each thread's replies oldest first", () => {
    const notes = [
      { id: "a", createdAt: "2026-11-01T10:00:00.000Z" },
      { id: "r2", parentId: "a", createdAt: "2026-11-01T12:00:00.000Z" },
      { id: "b", createdAt: "2026-11-01T11:00:00.000Z", resolvedAt: "2026-11-02T09:00:00.000Z" },
      { id: "r1", parentId: "a", createdAt: "2026-11-01T11:30:00.000Z" },
      { id: "rb", parentId: "b", createdAt: "2026-11-01T11:10:00.000Z" },
    ];
    const { open, resolved } = splitComments(notes);
    assert.deepEqual(open.map((c) => c.id), ["a"]);
    assert.deepEqual(resolved.map((c) => c.id), ["b"], "replies are never listed as threads, resolved or not");
    const threads = repliesByThread(notes);
    assert.deepEqual(threads.get("a")?.map((c) => c.id), ["r1", "r2"]);
    assert.deepEqual(threads.get("b")?.map((c) => c.id), ["rb"]);
    assert.equal(threads.get("r1"), undefined);
  });
});
