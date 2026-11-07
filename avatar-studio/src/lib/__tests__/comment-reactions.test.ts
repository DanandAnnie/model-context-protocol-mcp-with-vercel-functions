// Reactions on review notes: who gave which, taking them back, two at once, and how the page sees them.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { addComment, commentPatchSchema, createVideo, editComment, listComments, reactToComment, resolveComment, videoRequestSchema } from "../services";
import { markMine, reactionSummary } from "../comment-list";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { getStore } from "../store";
import type { VideoComment } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const ann = { id: "u-ann", email: "ann@example.com" };
const bob = { id: "u-bob" };

async function video(owner = "ws_team") {
  return createVideo(videoRequestSchema.parse({ title: "Notes", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), owner);
}

describe("reactToComment", () => {
  it("keeps who gave each reaction, once each, and takes one back", async () => {
    const v = await video();
    const note = await addComment(v.id, { text: "Tighten the intro." }, "ws_team", bob);
    await reactToComment(v.id, note.id, "👍", true, "ws_team", ann);
    const both = await reactToComment(v.id, note.id, "👍", true, "ws_team", bob);
    assert.deepEqual(both.reactions, { "👍": [{ userId: ann.id, email: ann.email }, { userId: bob.id }] }, "in the order given; no email is stored for a person without one");
    const again = await reactToComment(v.id, note.id, "👍", true, "ws_team", ann);
    assert.equal(again.reactions!["👍"].length, 2, "giving it twice counts once");
    assert.equal(again.rev, both.rev, "and writes nothing");
    await reactToComment(v.id, note.id, "✅", true, "ws_team", ann);
    const back = await reactToComment(v.id, note.id, "👍", false, "ws_team", ann);
    assert.deepEqual(back.reactions, { "👍": [{ userId: bob.id }], "✅": [{ userId: ann.id, email: ann.email }] });
    const none = await reactToComment(v.id, note.id, "👍", false, "ws_team", bob);
    assert.deepEqual(none.reactions, { "✅": [{ userId: ann.id, email: ann.email }] }, "a reaction no one gives is left out");
    const empty = await reactToComment(v.id, note.id, "✅", false, "ws_team", ann);
    assert.equal("reactions" in empty, false, "a note with none has no reactions field");
    assert.equal((await reactToComment(v.id, note.id, "🎉", false, "ws_team", ann)).rev, empty.rev, "taking back one never given changes nothing");
    assert.equal(empty.text, note.text, "the note itself is untouched");
  });

  it("reacts to replies and resolved notes, and editing or resolving keeps the reactions", async () => {
    const v = await video();
    const note = await addComment(v.id, { text: "Cut the pause." }, "ws_team", ann);
    const reply = await addComment(v.id, { text: "Done.", parentId: note.id }, "ws_team", bob);
    assert.equal((await reactToComment(v.id, reply.id, "🎉", true, "ws_team", ann)).reactions!["🎉"].length, 1);
    await reactToComment(v.id, note.id, "👀", true, "ws_team", bob);
    await resolveComment(v.id, note.id, true, "ws_team", bob);
    const onResolved = await reactToComment(v.id, note.id, "✅", true, "ws_team", ann);
    assert.deepEqual(Object.keys(onResolved.reactions!).sort(), ["✅", "👀"].sort());
    const { comment: edited } = await editComment(v.id, note.id, "Cut the long pause.", "ws_team", ann);
    assert.deepEqual(edited.reactions, onResolved.reactions, "an edit keeps them");
  });

  it("counts two reactions given at the same moment", async () => {
    const v = await video();
    const note = await addComment(v.id, { text: "Brighter?" }, "ws_team", ann);
    await Promise.all([reactToComment(v.id, note.id, "👍", true, "ws_team", ann), reactToComment(v.id, note.id, "👍", true, "ws_team", bob), reactToComment(v.id, note.id, "❤️", true, "ws_team", bob)]);
    const [stored] = await listComments(v.id, "ws_team");
    assert.deepEqual(stored.reactions?.["👍"]?.map((r) => r.userId).sort(), [ann.id, bob.id]);
    assert.equal(stored.reactions?.["❤️"]?.length, 1);
  });

  it("gives up with 409 on a note that changes on every try, and 404 on one deleted meanwhile", async () => {
    const v = await video();
    const note = await addComment(v.id, { text: "x" }, "ws_team", ann);
    const store = getStore();
    const putIf = store.putIf.bind(store);
    let calls = 0;
    store.putIf = (async () => {
      calls++;
      return false;
    }) as typeof store.putIf;
    await assert.rejects(reactToComment(v.id, note.id, "👍", true, "ws_team", ann), /changed meanwhile/);
    assert.equal(calls, 5, "tried five times");
    store.putIf = putIf;
    await assert.rejects(reactToComment(v.id, "cmt_missing", "👍", true, "ws_team", ann), /Comment not found/);
    await assert.rejects(reactToComment(v.id, note.id, "👍", true, "someone-else", ann), /not found/, "another owner cannot reach it");
    const w = await video();
    await assert.rejects(reactToComment(w.id, note.id, "👍", true, "ws_team", ann), /Comment not found/, "a note on another video");
  });

  it("counts two reactions at once on a note from before revisions", async () => {
    const v = await video();
    const note = await addComment(v.id, { text: "Older note" }, "ws_team", ann);
    const { rev: _rev, ...legacy } = note;
    await getStore().put("comment", legacy);
    await Promise.all([reactToComment(v.id, note.id, "👍", true, "ws_team", ann), reactToComment(v.id, note.id, "👍", true, "ws_team", bob)]);
    const [stored] = await listComments(v.id, "ws_team");
    assert.ok(stored.rev, "it has a revision now");
    assert.deepEqual(stored.reactions?.["👍"]?.map((r) => r.userId).sort(), [ann.id, bob.id]);
  });

  it("takes only the listed reactions, one change at a time", () => {
    assert.deepEqual(commentPatchSchema.parse({ reaction: "❤️", on: true }), { reaction: "❤️", on: true });
    assert.deepEqual(commentPatchSchema.parse({ reaction: "\u2764", on: true }), { reaction: "❤️", on: true }, "a bare heart is the listed one");
    for (const bad of [{ reaction: "🤡", on: true }, { reaction: "👍" }, { reaction: "👍", on: "yes" }, { reaction: "👍", on: true, resolved: true }, { reaction: "👍", on: true, text: "x" }]) {
      assert.equal(commentPatchSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});

describe("reactionSummary", () => {
  const note: Pick<VideoComment, "authorId" | "reactions"> = {
    authorId: "u-bob",
    reactions: { "🎉": [{ userId: "u-bob" }], "👍": [{ userId: "u-bob" }, { userId: "u-ann", email: "ann@example.com" }], "✅": [] },
  };

  it("lists the reactions given in the page's order, the reader as 'you' first", () => {
    assert.deepEqual(reactionSummary(note, "u-ann"), [
      { emoji: "👍", count: 2, mine: true, by: ["you", "a teammate"] },
      { emoji: "🎉", count: 1, mine: false, by: ["a teammate"] },
    ]);
    assert.deepEqual(reactionSummary(note, "u-carl")[0], { emoji: "👍", count: 2, mine: false, by: ["a teammate", "ann@example.com"] });
    assert.deepEqual(reactionSummary({}, "u-ann"), []);
  });

  it("is what every comment response carries for its reader", () => {
    const [marked] = markMine([note], "u-bob");
    assert.equal(marked.mine, true);
    assert.deepEqual(marked.reactionList.map((r) => [r.emoji, r.mine]), [["👍", true], ["🎉", true]]);
  });
});
