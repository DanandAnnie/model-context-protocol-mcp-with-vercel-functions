// @mentions in video comments: who is matched and what the email says.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MAX_MENTIONS, MENTION_EMAILS_PER_HOUR, addComment, commentSchema, createVideo, findMentions, notifyMentions, videoRequestSchema } from "../services";
import { MockEmailProvider, setEmailProvider } from "../providers/email";
import { acceptInvite, createInvite, createWorkspace, inviteSchema } from "../workspaces";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { resetRateLimit } from "../rate-limit";
import { getStore } from "../store";
import type { Video } from "../types";

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
    assert.deepEqual(findMentions("write to alice@bob@example.com", ws, carol.id), [], "the middle of a plain address is not a mention");
    assert.deepEqual(findMentions("(@bob@example.com)", ws, alice.id).map((m) => m.userId), [bob.id], "opening punctuation may come first");
    const accented = { members: [{ userId: "u_ob", email: "o'brien@exämple.de", role: "editor" as const, joinedAt: "" }] };
    assert.deepEqual(findMentions("@o'brien@exämple.de hi", accented, alice.id).map((m) => m.userId), ["u_ob"]);
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

  it("pins a comment to a moment: kept to tenths, checked against the length, and named in the email with a link that opens there", async () => {
    const { ws, video } = await team();
    await assert.rejects(addComment(video.id, commentSchema.parse({ text: "too soon", atSec: 1 }), ws.id, alice), /once the video has finished rendering/);
    // Demo renders all play one sample whose length the script estimate does not match, so theirs is not checked.
    const demo = await getStore().put<Video>("video", { ...(await getStore().get<Video>("video", video.id))!, status: "completed", durationSec: 5 });
    assert.equal(demo.provider, "mock");
    assert.equal((await addComment(video.id, commentSchema.parse({ text: "inside the sample", atSec: 8 }), ws.id, alice)).atSec, 8);
    await getStore().put<Video>("video", { ...demo, provider: "heygen", durationSec: 90 });
    const pinned = await addComment(video.id, commentSchema.parse({ text: "@bob@example.com the cut here", atSec: 65.437 }), ws.id, alice);
    assert.equal(pinned.atSec, 65.4);
    assert.equal(await notifyMentions(pinned), 1);
    assert.match(mail.sent[0].text, /in a comment on "Launch <teaser>" at 1:05:/);
    assert.ok(mail.sent[0].text.includes(`/videos/${video.id}?ws=${ws.id}&t=65`), "the link opens the player at the note");
    assert.match(mail.sent[0].html, /<strong>Launch &lt;teaser&gt;<\/strong> at 1:05:/);
    // The end itself is fine (players report a little past it); a point past it is not.
    assert.equal((await addComment(video.id, commentSchema.parse({ text: "last frame", atSec: 90.3 }), ws.id, alice)).atSec, 90.3);
    await assert.rejects(addComment(video.id, commentSchema.parse({ text: "too far", atSec: 95 }), ws.id, alice), /past the end of the video \(1:30\)/);
    // A note on the whole video carries no time, and its email no "at" or `t`.
    const whole = await addComment(video.id, commentSchema.parse({ text: "@bob@example.com overall", atSec: null }), ws.id, alice);
    assert.equal("atSec" in whole, false);
    await notifyMentions(whole);
    assert.doesNotMatch(mail.sent[1].text, / at \d|&t=/);
    assert.equal(mail.sent.length, 2);
    assert.throws(() => commentSchema.parse({ text: "x", atSec: -1 }));
    assert.throws(() => commentSchema.parse({ text: "x", atSec: "12" }));
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

  it("stops emailing once the author's hourly allowance is used, but still posts the comment", async () => {
    const { ws, video } = await team();
    const text = commentSchema.parse({ text: "@bob@example.com @carol@example.com again" });
    for (let i = 0; i < MENTION_EMAILS_PER_HOUR / 2; i += 1) assert.equal(await notifyMentions(await addComment(video.id, text, ws.id, alice)), 2);
    const over = await addComment(video.id, text, ws.id, alice);
    assert.equal(over.mentions?.length, 2, "the comment and its mentions are kept");
    assert.equal(await notifyMentions(over), 0);
    assert.equal(mail.sent.length, MENTION_EMAILS_PER_HOUR);
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
