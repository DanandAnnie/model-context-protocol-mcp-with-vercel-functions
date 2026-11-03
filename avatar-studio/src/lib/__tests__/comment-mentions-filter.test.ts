// Open threads that name the reader: counted per video, filtered on in the library, and left out once resolved.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { addComment, commentCounts, commentSchema, createVideo, filterVideos, queryVideos, resolveComment, videoQuerySchema, videoRequestSchema } from "../services";
import { acceptInvite, createInvite, createWorkspace, inviteSchema } from "../workspaces";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { getStore } from "../store";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const alice = { id: "user_alice", email: "alice@example.com" };
const bob = { id: "user_bob", email: "bob@example.com" };
const carol = { id: "user_carol", email: "carol@example.com" };
const say = (text: string, parentId?: string) => commentSchema.parse({ text, ...(parentId ? { parentId } : {}) });

async function team() {
  const ws = await createWorkspace("Acme", alice);
  for (const u of [bob, carol]) await acceptInvite((await createInvite(ws.id, inviteSchema.parse({}), alice)).token, u);
  const make = (title: string) => createVideo(videoRequestSchema.parse({ title, script: "Hello team.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), ws.id);
  return { ws, a: await make("mx alpha"), b: await make("mx bravo"), c: await make("mx charlie") };
}

describe("comments that mention the reader", () => {
  it("counts each open thread that names them once, in its note or a reply, and not once resolved", async () => {
    const { ws, a, b, c } = await team();
    // On a: one thread naming bob twice (note and reply), one naming him in a reply only, one naming carol.
    const t1 = await addComment(a.id, say("@bob@example.com the intro"), ws.id, alice);
    await addComment(a.id, say("@bob@example.com and the outro", t1.id), ws.id, carol);
    const t2 = await addComment(a.id, say("Music too loud?"), ws.id, alice);
    await addComment(a.id, say("Agreed, @bob@example.com can you fix it?", t2.id), ws.id, carol);
    await addComment(a.id, say("@carol@example.com the logo"), ws.id, alice);
    // On b: a thread naming bob, resolved. On c: a thread with no mention at all.
    const t3 = await addComment(b.id, say("@bob@example.com the cut"), ws.id, alice);
    await resolveComment(b.id, t3.id, true, ws.id, carol);
    await addComment(c.id, say("Looks good"), ws.id, alice);
    const forBob = await commentCounts(ws.id, bob.id);
    assert.deepEqual(Object.fromEntries(forBob.mentions), { [a.id]: 2 });
    assert.deepEqual(Object.fromEntries(forBob.open), { [a.id]: 3, [c.id]: 1 }, "the open counts are as before");
    assert.deepEqual(Object.fromEntries((await commentCounts(ws.id, carol.id)).mentions), { [a.id]: 1 });
    assert.deepEqual(Object.fromEntries((await commentCounts(ws.id, alice.id)).mentions), {}, "the author named no one as alice");
    assert.deepEqual(Object.fromEntries((await commentCounts(ws.id)).mentions), {}, "no reader, no mentions");
    // Reopened, b's thread counts again.
    await resolveComment(b.id, t3.id, false, ws.id, carol);
    assert.deepEqual(Object.fromEntries((await commentCounts(ws.id, bob.id)).mentions), { [a.id]: 2, [b.id]: 1 });
  });

  it("says when someone other than the reader last wrote in an open thread, for the library to mark what is new", async () => {
    const { ws, a, b, c } = await team();
    const t1 = await addComment(a.id, say("The intro"), ws.id, alice);
    const reply = await addComment(a.id, say("Fixed it", t1.id), ws.id, bob);
    await addComment(a.id, say("Thanks"), ws.id, alice);
    const t2 = await addComment(b.id, say("The cut"), ws.id, alice);
    await resolveComment(b.id, t2.id, true, ws.id, carol);
    await addComment(c.id, say("My own note"), ws.id, bob);
    const forAlice = await commentCounts(ws.id, alice.id);
    // On a, bob's reply is the newest someone else wrote; alice's later note is her own. b's thread is resolved.
    assert.deepEqual(Object.fromEntries(forAlice.latest), { [a.id]: reply.createdAt, [c.id]: (await getStore().list<{ videoId: string; createdAt: string }>("comment", ws.id)).find((x) => x.videoId === c.id)!.createdAt });
    // For bob, alice's newest note on a counts, and his own note on c does not.
    const forBob = await commentCounts(ws.id, bob.id);
    assert.deepEqual([...forBob.latest.keys()].sort(), [a.id]);
    assert.ok(Date.parse(forBob.latest.get(a.id)!) >= Date.parse(reply.createdAt));
    assert.deepEqual(Object.fromEntries((await commentCounts(ws.id)).latest), {}, "no reader, nothing to compare");
    // latestAny is the same in any thread, resolved ones too: b's resolved thread counts there, and a reply in it later on.
    assert.equal(forAlice.latestAny.get(b.id), undefined, "alice wrote b's note herself");
    const late = await addComment(a.id, say("Second look"), ws.id, bob);
    await resolveComment(a.id, late.id, true, ws.id, carol);
    const afterResolve = await commentCounts(ws.id, alice.id);
    assert.equal(afterResolve.latest.get(a.id), reply.createdAt, "a resolved thread is not counted as open");
    assert.equal(afterResolve.latestAny.get(a.id), late.createdAt, "but it is in what opening the video marks");
    assert.deepEqual((await queryVideos(ws.id, videoQuerySchema.parse({}), alice.id)).latestAnyComment[a.id], late.createdAt);
    await resolveComment(a.id, late.id, false, ws.id, carol);
    await getStore().remove("comment", late.id);
    // The reader's own reply after a teammate's does not move it.
    await addComment(a.id, say("Looks right now", t1.id), ws.id, alice);
    assert.equal((await commentCounts(ws.id, alice.id)).latest.get(a.id), reply.createdAt);
    // The library's page carries them, with the reader's id.
    const page = await queryVideos(ws.id, videoQuerySchema.parse({}), alice.id);
    assert.equal(page.you, alice.id);
    assert.deepEqual(page.latestComment, Object.fromEntries(forAlice.latest));
    assert.equal((await queryVideos(ws.id, videoQuerySchema.parse({}))).you, undefined);
  });

  it("a reply whose note is gone still counts on its own", async () => {
    const { ws, a } = await team();
    const t = await addComment(a.id, say("A note"), ws.id, alice);
    await addComment(a.id, say("@bob@example.com see this", t.id), ws.id, carol);
    await getStore().remove("comment", t.id);
    assert.deepEqual(Object.fromEntries((await commentCounts(ws.id, bob.id)).mentions), { [a.id]: 1 });
  });

  it("filters the library to the videos that mention the reader, and says how many on each", async () => {
    const { ws, a, b } = await team();
    await addComment(a.id, say("@bob@example.com the intro"), ws.id, alice);
    await addComment(b.id, say("Fine as is"), ws.id, alice);
    const page = await queryVideos(ws.id, videoQuerySchema.parse({ q: "mx", comments: "mentions" }), bob.id);
    assert.deepEqual(page.videos.map((v) => v.id), [a.id]);
    assert.deepEqual(page.mentions, { [a.id]: 1 });
    assert.deepEqual(page.openComments, { [a.id]: 1 });
    const all = await queryVideos(ws.id, videoQuerySchema.parse({ q: "mx" }), bob.id);
    assert.deepEqual(all.mentions, { [a.id]: 1 }, "every page says it, whatever the filter");
    assert.deepEqual((await queryVideos(ws.id, videoQuerySchema.parse({ q: "mx", comments: "mentions" }), carol.id)).videos, []);
    assert.deepEqual((await queryVideos(ws.id, videoQuerySchema.parse({ q: "mx", comments: "mentions" }))).videos, [], "an unknown reader is named nowhere");
    assert.throws(() => filterVideos([a], videoQuerySchema.parse({ comments: "mentions" }), new Map()), /mentions filter needs the counts/);
    assert.throws(() => videoQuerySchema.parse({ comments: "mine" }));
  });
});
