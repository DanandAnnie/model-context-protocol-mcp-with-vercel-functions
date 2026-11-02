// Resolving review notes on a video: who may, what is kept, and how the card lists them.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { addComment, commentPatchSchema, createVideo, listComments, reactToComment, resolveAllComments, resolveAllSchema, resolveComment, videoRequestSchema } from "../services";
import { splitComments } from "../comment-list";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { getStore } from "../store";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const ann = { id: "u-ann", email: "ann@example.com" };
const bob = { id: "u-bob" };

async function video(owner = "ws_team") {
  return createVideo(videoRequestSchema.parse({ title: "Notes", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), owner);
}

describe("resolveComment", () => {
  it("marks a note done by whoever acted on it, keeps the first resolver, and reopens it", async () => {
    const v = await video();
    const note = await addComment(v.id, { text: "Tighten the intro." }, "ws_team", bob);
    const done = await resolveComment(v.id, note.id, true, "ws_team", ann);
    assert.equal(done.resolvedById, ann.id, "someone other than the author may resolve it");
    assert.equal(done.resolvedByEmail, ann.email);
    assert.ok(done.resolvedAt);
    assert.equal(done.text, note.text, "the note itself is untouched");
    const again = await resolveComment(v.id, note.id, true, "ws_team", bob);
    assert.equal(again.resolvedById, ann.id, "resolving again keeps who resolved it first");
    assert.equal(again.resolvedAt, done.resolvedAt);
    const reopened = await resolveComment(v.id, note.id, false, "ws_team", bob);
    assert.equal(reopened.resolvedAt, undefined);
    assert.equal(reopened.resolvedById, undefined);
    assert.equal("resolvedByEmail" in reopened, false, "no resolver is left behind on an open note");
    assert.deepEqual(await listComments(v.id, "ws_team"), [reopened], "the stored note is the reopened one");
    const plain = await resolveComment(v.id, note.id, true, "ws_team", bob);
    assert.equal("resolvedByEmail" in plain, false, "a resolver without an email is stored without one");
  });

  it("finds only the video's own notes, for its own owner", async () => {
    const v = await video();
    const w = await video();
    const note = await addComment(v.id, { text: "x" }, "ws_team", ann);
    await assert.rejects(resolveComment(w.id, note.id, true, "ws_team", ann), /Comment not found/, "a note on another video");
    await assert.rejects(resolveComment(v.id, "cmt_missing", true, "ws_team", ann), /Comment not found/);
    await assert.rejects(resolveComment(v.id, note.id, true, "someone-else", ann), /not found/, "another owner cannot reach it");
    assert.equal((await listComments(v.id, "ws_team"))[0].resolvedAt, undefined);
  });

  it("checks the note's own owner, not only the video's", async () => {
    const v = await video();
    const stray = { id: "cmt_stray", ownerId: "ws_other", videoId: v.id, authorId: "u-x", text: "x", createdAt: new Date().toISOString() };
    await getStore().put("comment", stray);
    await assert.rejects(resolveComment(v.id, stray.id, true, "ws_team", ann), /Comment not found/, "the video is the caller's, the note is not");
    assert.equal((await getStore().get<typeof stray & { resolvedAt?: string }>("comment", stray.id))?.resolvedAt, undefined);
  });

  it("does not bring back a note deleted while it was being resolved", async () => {
    const v = await video();
    const note = await addComment(v.id, { text: "Gone soon." }, "ws_team", ann);
    const store = getStore();
    const get = store.get.bind(store);
    // The author's delete lands between this request's read and its write.
    store.get = (async (kind: string, id: string) => {
      const item = await get(kind as never, id);
      if (kind === "comment" && id === note.id) await store.remove("comment", id);
      return item;
    }) as typeof store.get;
    try {
      await assert.rejects(resolveComment(v.id, note.id, true, "ws_team", bob), /Comment not found/);
    } finally {
      store.get = get;
    }
    assert.equal(await getStore().get("comment", note.id), null);
    assert.deepEqual(await listComments(v.id, "ws_team"), []);
  });

  it("takes only { resolved: boolean }", () => {
    assert.deepEqual(commentPatchSchema.parse({ resolved: true }), { resolved: true });
    for (const bad of [{}, { resolved: "yes" }, { resolved: true, text: "edit" }, { resolved: null }]) {
      assert.equal(commentPatchSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});

describe("resolveAllComments", () => {
  it("resolves the open threads named, with their replies, by the person who asked, and counts them", async () => {
    const v = await video();
    const a = await addComment(v.id, { text: "Tighten the intro." }, "ws_team", bob);
    const reply = await addComment(v.id, { text: "On it.", parentId: a.id }, "ws_team", ann);
    const b = await addComment(v.id, { text: "Brighter end card." }, "ws_team", bob);
    const done = await addComment(v.id, { text: "Typo in the title." }, "ws_team", bob);
    const first = await resolveComment(v.id, done.id, true, "ws_team", bob);
    // A reply whose note is gone is a thread of its own.
    const gone = await addComment(v.id, { text: "Swap the music." }, "ws_team", bob);
    const orphan = await addComment(v.id, { text: "Which track?", parentId: gone.id }, "ws_team", ann);
    await getStore().remove("comment", gone.id);
    // Started after the person looked, so not among the ids sent: it stays open.
    const later = await addComment(v.id, { text: "One more thing." }, "ws_team", bob);
    const ids = [a.id, b.id, orphan.id, done.id, reply.id, "cmt_missing"];
    assert.deepEqual(await resolveAllComments(v.id, ids, "ws_team", ann), { resolved: 3, failed: 0, open: 1 });
    const after = await listComments(v.id, "ws_team");
    assert.deepEqual(splitComments(after).open.map((c) => c.id), [later.id]);
    assert.equal(after.find((c) => c.id === a.id)?.resolvedById, ann.id, "resolved by the person who asked");
    assert.equal(after.find((c) => c.id === done.id)?.resolvedAt, first.resolvedAt, "one resolved before keeps who did it");
    assert.equal(after.find((c) => c.id === reply.id)?.resolvedAt, undefined, "a reply goes with its thread, not on its own");
    assert.deepEqual(await resolveAllComments(v.id, ids, "ws_team", ann), { resolved: 0, failed: 0, open: 1 }, "none of them open is none resolved");
  });

  it("tries a thread changed meanwhile again, and counts one that keeps changing as failed without stopping the rest", async () => {
    const v = await video();
    const a = await addComment(v.id, { text: "One" }, "ws_team", ann);
    const b = await addComment(v.id, { text: "Two" }, "ws_team", bob);
    const store = getStore();
    const putIf = store.putIf.bind(store);
    const tries = new Map<string, number>();
    store.putIf = (async (kind: Parameters<typeof putIf>[0], item: { id: string }, ...rest: unknown[]) => {
      tries.set(item.id, (tries.get(item.id) ?? 0) + 1);
      // The first write to "One" loses a race; "Two" loses every time.
      if (item.id === b.id || (item.id === a.id && tries.get(a.id) === 1)) return false;
      return (putIf as (...args: unknown[]) => Promise<boolean>)(kind, item, ...rest);
    }) as typeof store.putIf;
    try {
      assert.deepEqual(await resolveAllComments(v.id, [a.id, b.id], "ws_team", ann), { resolved: 1, failed: 1, open: 1 });
    } finally {
      store.putIf = putIf;
    }
    assert.equal(tries.get(a.id), 2, "tried again after losing the race");
    assert.equal(tries.get(b.id), 5, "given up after five tries");
    const after = await listComments(v.id, "ws_team");
    assert.ok(after.find((c) => c.id === a.id)?.resolvedAt);
    assert.equal(after.find((c) => c.id === b.id)?.resolvedAt, undefined);
  });

  it("keeps a reaction given in the same moment, and to the owner's own video", async () => {
    const v = await video();
    const a = await addComment(v.id, { text: "One" }, "ws_team", ann);
    await Promise.all([resolveAllComments(v.id, [a.id], "ws_team", ann), reactToComment(v.id, a.id, "👍", true, "ws_team", bob)]);
    const [after] = await listComments(v.id, "ws_team");
    assert.ok(after.resolvedAt);
    assert.equal(after.reactions?.["👍"]?.length, 1);
    await assert.rejects(resolveAllComments(v.id, [a.id], "someone-else", ann), /not found/);
    assert.equal(resolveAllSchema.safeParse({ ids: [] }).success, false, "nothing named is a 400");
    assert.equal(resolveAllSchema.safeParse({ ids: Array.from({ length: 201 }, (_, i) => `cmt_${i}`) }).success, false);
  });
});

describe("splitComments", () => {
  it("keeps open notes in writing order and lists the most recently resolved first", () => {
    const notes = [
      { id: "a", resolvedAt: "2026-11-01T10:00:00.000Z" },
      { id: "b" },
      { id: "c", resolvedAt: "2026-11-02T09:00:00.000Z" },
      { id: "d" },
    ];
    const { open, resolved } = splitComments(notes);
    assert.deepEqual(open.map((c) => c.id), ["b", "d"]);
    assert.deepEqual(resolved.map((c) => c.id), ["c", "a"]);
    assert.deepEqual(notes.map((c) => c.id), ["a", "b", "c", "d"], "the list given is not reordered");
    assert.deepEqual(splitComments([]), { open: [], resolved: [] });
  });
});
