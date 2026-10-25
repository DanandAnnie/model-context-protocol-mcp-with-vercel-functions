// @mentions in video comments: who is matched and what the email says.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_MENTIONS, addComment, commentSchema, createVideo, findMentions, notifyMentions, videoRequestSchema } from "../services";
import { MockEmailProvider, setEmailProvider } from "../providers/email";
import { acceptInvite, createInvite, createWorkspace, inviteSchema } from "../workspaces";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

let mail: MockEmailProvider;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  mail = new MockEmailProvider();
  setEmailProvider(mail);
});
afterEach(() => setEmailProvider(undefined));

const alice = { id: "user_alice", email: "alice@example.com" };
const bob = { id: "user_bob", email: "Bob@Example.com" };
const carol = { id: "user_carol", email: "carol@example.com" };

async function team() {
  const ws = await createWorkspace("Acme", alice);
  for (const u of [bob, carol]) await acceptInvite((await createInvite(ws.id, inviteSchema.parse({}), alice)).token, u);
  const video = await createVideo(videoRequestSchema.parse({ title: "Launch <teaser>", script: "Hello team.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), ws.id);
  return { ws, video };
}

describe("comment mentions", () => {
  it("matches members by address, ignoring case, strangers, the author, and repeats", () => {
    const ws = { members: [
      { userId: alice.id, email: alice.email, role: "owner" as const, joinedAt: "" },
      { userId: bob.id, email: bob.email, role: "editor" as const, joinedAt: "" },
      { userId: "user_noemail", role: "viewer" as const, joinedAt: "" },
    ] };
    const text = "@bob@example.com. can you check? cc @alice@example.com @mallory@evil.test and again @BOB@example.com";
    assert.deepEqual(findMentions(text, ws, alice.id), [{ userId: bob.id, email: "Bob@Example.com" }]);
    assert.deepEqual(findMentions("mail bob@example.com directly", ws, alice.id), [], "an address without the @ is not a mention");
    const many = { members: Array.from({ length: MAX_MENTIONS + 3 }, (_, i) => ({ userId: `u${i}`, email: `p${i}@example.com`, role: "editor" as const, joinedAt: "" })) };
    assert.equal(findMentions(many.members.map((m) => `@${m.email}`).join(" "), many, "someone").length, MAX_MENTIONS);
  });

  it("records the mentions on a workspace comment and emails each teammate a link into the workspace", async () => {
    const { ws, video } = await team();
    const comment = await addComment(video.id, commentSchema.parse({ text: "@bob@example.com and @carol@example.com: the intro runs long." }), ws.id, alice);
    assert.deepEqual(comment.mentions?.map((m) => m.userId), [bob.id, carol.id]);
    assert.equal(await notifyMentions(comment), 2);
    assert.deepEqual(mail.sent.map((m) => m.to), ["Bob@Example.com", "carol@example.com"]);
    const msg = mail.sent[0];
    assert.equal(msg.subject, 'alice@example.com mentioned you on "Launch <teaser>"');
    assert.match(msg.text, /the intro runs long/);
    assert.ok(msg.text.includes(`/videos/${video.id}?ws=${ws.id}`), "the link switches the reader into the workspace");
    assert.match(msg.html, /Launch &lt;teaser&gt;/, "html escapes the title");
    assert.equal(msg.replyTo, alice.email, "a reply goes to the author");
  });

  it("keeps notifying the others when one send fails", async () => {
    const { ws, video } = await team();
    mail.send = async (m) => {
      if (m.to === "Bob@Example.com") throw new Error("mailbox unavailable");
      mail.sent.push(m);
    };
    const comment = await addComment(video.id, commentSchema.parse({ text: "@bob@example.com @carol@example.com look" }), ws.id, alice);
    assert.equal(await notifyMentions(comment), 1);
    assert.deepEqual(mail.sent.map((m) => m.to), ["carol@example.com"]);
  });

  it("does nothing in a personal space or for someone outside the workspace", async () => {
    const mine = await createVideo(videoRequestSchema.parse({ title: "Mine", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), alice.id);
    const personal = await addComment(mine.id, commentSchema.parse({ text: "@bob@example.com hi" }), alice.id, alice);
    assert.equal(personal.mentions, undefined);
    const { ws, video } = await team();
    const outside = await addComment(video.id, commentSchema.parse({ text: "@dave@example.com hi" }), ws.id, alice);
    assert.equal(outside.mentions, undefined);
    assert.equal(await notifyMentions(outside), 0);
    assert.equal(mail.sent.length, 0);
  });
});
