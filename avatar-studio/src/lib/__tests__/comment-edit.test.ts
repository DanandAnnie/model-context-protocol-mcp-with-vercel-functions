// Editing a review note: only its author may, mentions are read again, and only new ones are mailed.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { addComment, commentPatchSchema, createVideo, editComment, listComments, notifyMentions, resolveComment, videoRequestSchema } from "../services";
import { markMine } from "../comment-list";
import { getStore as storeOf } from "../store";
import { MockEmailProvider, setEmailProvider } from "../providers/email";
import { acceptInvite, createInvite, createWorkspace, inviteSchema } from "../workspaces";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { resetRateLimit } from "../rate-limit";
import { getStore } from "../store";

const alice = { id: "user_alice", email: "alice@example.com" };
const bob = { id: "user_bob", email: "bob@example.com" };
const carol = { id: "user_carol", email: "carol@example.com" };

let mail: MockEmailProvider;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  mail = new MockEmailProvider();
  setEmailProvider(mail);
});
afterEach(() => {
  setEmailProvider(undefined);
  for (const key of [`mention-email:sender:${alice.id}`, "mention-email:global"]) resetRateLimit(key);
});

async function team() {
  const ws = await createWorkspace("Acme", alice);
  for (const u of [bob, carol]) await acceptInvite((await createInvite(ws.id, inviteSchema.parse({}), alice)).token, u);
  const video = await createVideo(videoRequestSchema.parse({ title: "Launch", script: "Hello team.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), ws.id);
  return { ws, video };
}

describe("editComment", () => {
  it("changes the author's own note, marks it edited, and keeps everything else", async () => {
    const { ws, video } = await team();
    const note = await addComment(video.id, { text: "Tighten the intro.", atSec: undefined }, ws.id, alice);
    const { comment, newMentions } = await editComment(video.id, note.id, "Tighten the intro and the outro.", ws.id, alice);
    assert.equal(comment.text, "Tighten the intro and the outro.");
    assert.ok(comment.editedAt);
    assert.equal(comment.createdAt, note.createdAt, "it keeps its place in the list");
    assert.equal(comment.authorId, alice.id);
    assert.deepEqual(newMentions, []);
    assert.deepEqual(await listComments(video.id, ws.id), [comment]);
    const same = await editComment(video.id, note.id, comment.text, ws.id, alice);
    assert.equal(same.comment.editedAt, comment.editedAt, "the same text changes nothing");
  });

  it("is the author's alone, and finds only the video's own notes", async () => {
    const { ws, video } = await team();
    const note = await addComment(video.id, { text: "Mine." }, ws.id, alice);
    await assert.rejects(editComment(video.id, note.id, "Yours now.", ws.id, bob), /Only the author can edit/);
    const other = await createVideo(videoRequestSchema.parse({ title: "Other", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), ws.id);
    await assert.rejects(editComment(other.id, note.id, "x", ws.id, alice), /Comment not found/);
    await assert.rejects(editComment(video.id, note.id, "x", "someone-else", alice), /not found/);
    assert.equal((await listComments(video.id, ws.id))[0].text, "Mine.");
  });

  it("reads mentions again and returns only the members named for the first time", async () => {
    const { ws, video } = await team();
    const note = await addComment(video.id, { text: "@bob@example.com look" }, ws.id, alice);
    assert.deepEqual(note.mentions?.map((m) => m.userId), [bob.id]);
    const added = await editComment(video.id, note.id, "@bob@example.com and @carol@example.com look", ws.id, alice);
    assert.deepEqual(added.comment.mentions?.map((m) => m.userId), [bob.id, carol.id]);
    assert.deepEqual(added.newMentions?.map((m) => m.userId), [carol.id], "bob was named before");
    assert.equal(await notifyMentions({ ...added.comment, mentions: added.newMentions }), 1);
    assert.deepEqual(mail.sent.map((m) => m.to), [carol.email], "only carol is mailed for the edit");
    const dropped = await editComment(video.id, note.id, "never mind", ws.id, alice);
    assert.equal(dropped.comment.mentions, undefined, "no one named, no mentions kept");
    assert.deepEqual(dropped.newMentions, []);
    // Naming carol again after taking her out does not mail her a second time.
    const back = await editComment(video.id, note.id, "@carol@example.com after all", ws.id, alice);
    assert.deepEqual(back.comment.mentions?.map((m) => m.userId), [carol.id]);
    assert.deepEqual(back.newMentions, [], "carol was named before");
    assert.deepEqual([...(back.comment.notified ?? [])].sort(), [bob.id, carol.id].sort());
  });

  it("keeps the moment, the resolution, and the author when only the text changes", async () => {
    const { ws, video } = await team();
    const v = await storeOf().get<typeof video>("video", video.id);
    await storeOf().put("video", { ...v!, status: "completed" });
    const note = await addComment(video.id, { text: "Here.", atSec: 1.5 }, ws.id, alice);
    await resolveComment(video.id, note.id, true, ws.id, bob);
    const { comment } = await editComment(video.id, note.id, "Here, exactly.", ws.id, alice);
    assert.equal(comment.atSec, 1.5);
    assert.equal(comment.resolvedById, bob.id, "still resolved, by bob");
    assert.ok(comment.resolvedAt);
  });

  it("refuses to overwrite a note changed while it was being edited", async () => {
    const { ws, video } = await team();
    const note = await addComment(video.id, { text: "Draft." }, ws.id, alice);
    const store = getStore();
    const get = store.get.bind(store);
    // bob resolves it between this edit's read and its write.
    let raced = false;
    store.get = (async (kind: string, id: string) => {
      const item = await get(kind as never, id);
      if (kind === "comment" && id === note.id && !raced) {
        raced = true;
        store.get = get;
        await resolveComment(video.id, note.id, true, ws.id, bob);
      }
      return item;
    }) as typeof store.get;
    try {
      await assert.rejects(editComment(video.id, note.id, "Final.", ws.id, alice), /changed meanwhile/);
    } finally {
      store.get = get;
    }
    const [stored] = await listComments(video.id, ws.id);
    assert.equal(stored.text, "Draft.", "the edit did not land");
    assert.equal(stored.resolvedById, bob.id, "and bob's resolve was not undone");
  });

  it("does not bring back a note deleted while it was being edited", async () => {
    const { ws, video } = await team();
    const note = await addComment(video.id, { text: "Gone soon." }, ws.id, alice);
    const store = getStore();
    const get = store.get.bind(store);
    store.get = (async (kind: string, id: string) => {
      const item = await get(kind as never, id);
      if (kind === "comment" && id === note.id) await store.remove("comment", id);
      return item;
    }) as typeof store.get;
    try {
      await assert.rejects(editComment(video.id, note.id, "Back?", ws.id, alice), /Comment not found/);
    } finally {
      store.get = get;
    }
    assert.deepEqual(await listComments(video.id, ws.id), []);
  });

  it("marks the caller's own notes as theirs", () => {
    const notes = [{ id: "a", authorId: alice.id }, { id: "b", authorId: bob.id }];
    assert.deepEqual(markMine(notes, alice.id).map((c) => c.mine), [true, false]);
    assert.deepEqual(markMine(notes, "ws_team").map((c) => c.mine), [false, false], "a workspace key's owner wrote neither");
  });

  it("takes either { resolved } or { text }, one at a time", () => {
    assert.deepEqual(commentPatchSchema.parse({ text: "  New words.  " }), { text: "New words." });
    assert.deepEqual(commentPatchSchema.parse({ resolved: false }), { resolved: false });
    for (const bad of [{}, { text: "" }, { text: "   " }, { text: "x".repeat(1001) }, { text: "x", resolved: true }, { text: "x", atSec: 3 }]) {
      assert.equal(commentPatchSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 60));
    }
  });
});
