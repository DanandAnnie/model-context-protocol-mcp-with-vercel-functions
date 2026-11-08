// Reply emails on review comments: who in a thread is told it was answered, and what the email says.
// Run with: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { MENTION_EMAILS_PER_HOUR, addComment, commentSchema, createVideo, notifyMentions, notifyReply, videoRequestSchema } from "../services";
import { MockEmailProvider, setEmailProvider } from "../providers/email";
import { acceptInvite, createInvite, createWorkspace, inviteSchema, removeMember } from "../workspaces";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { resetRateLimit } from "../rate-limit";
import { getStore } from "../store";
import { threadLink } from "../comment-list";
import type { Video } from "../types";

let mail: MockEmailProvider;
beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
  mail = new MockEmailProvider();
  setEmailProvider(mail);
});
afterEach(() => {
  setEmailProvider(undefined);
  for (const u of [alice, bob, carol, dave]) resetRateLimit(`mention-email:sender:${u.id}`);
  resetRateLimit("mention-email:global");
});

const alice = { id: "user_alice", email: "alice@example.com" };
const bob = { id: "user_bob", email: "bob@example.com" };
const carol = { id: "user_carol", email: "carol@example.com" };
const dave = { id: "user_dave", email: "dave@example.com" };

async function team() {
  const ws = await createWorkspace("Acme", alice);
  for (const u of [bob, carol, dave]) await acceptInvite((await createInvite(ws.id, inviteSchema.parse({}), alice)).token, u);
  const video = await createVideo(videoRequestSchema.parse({ title: "Launch <teaser>", script: "Hello team.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), ws.id);
  return { ws, video };
}
const say = (text: string, parentId?: string) => commentSchema.parse({ text, ...(parentId ? { parentId } : {}) });

describe("reply emails", () => {
  it("tells the note's author, with the reply, the note, and a link to the thread in its workspace", async () => {
    const { ws, video } = await team();
    const note = await addComment(video.id, say("The intro runs long."), ws.id, alice);
    const reply = await addComment(video.id, say("Cut to 10 seconds <tomorrow>.", note.id), ws.id, bob);
    assert.equal(await notifyReply(reply), 1);
    assert.equal(mail.sent.length, 1);
    const msg = mail.sent[0];
    assert.equal(msg.to, alice.email);
    assert.equal(msg.subject, 'bob@example.com replied on "Launch <teaser>"');
    assert.match(msg.text, /Cut to 10 seconds <tomorrow>\.\n\nIn reply to:\nThe intro runs long\./);
    assert.ok(msg.text.includes(`/videos/${video.id}?ws=${ws.id}&comment=${note.id}`), "the link opens the thread in the workspace");
    assert.match(msg.html, /Cut to 10 seconds &lt;tomorrow&gt;/);
    assert.match(msg.html, /Launch &lt;teaser&gt;/);
    assert.equal(msg.replyTo, bob.email, "answering the email reaches the one who replied");
  });

  it("tells everyone earlier in the thread once, but not the one replying, nor anyone the reply mentions", async () => {
    const { ws, video } = await team();
    const note = await addComment(video.id, say("Music too loud?"), ws.id, alice);
    await addComment(video.id, say("Agreed.", note.id), ws.id, bob);
    await addComment(video.id, say("Also agreed.", note.id), ws.id, bob);
    await addComment(video.id, say("Lowering it.", note.id), ws.id, carol);
    const last = await addComment(video.id, say("@bob@example.com can you check the new mix?", note.id), ws.id, alice);
    assert.deepEqual(last.mentions?.map((m) => m.userId), [bob.id]);
    assert.equal(await notifyReply(last), 1, "carol only: alice wrote it and bob is mentioned");
    assert.deepEqual(mail.sent.map((m) => m.to), [carol.email]);
    assert.equal(await notifyMentions(last), 1);
    assert.equal(mail.sent[1].to, bob.email);
    assert.match(mail.sent[1].subject, /mentioned you/);
    assert.ok(mail.sent[1].text.includes(`&comment=${note.id}`), "a mention in a reply links to its thread");
    // Dave was never in the thread, so he hears nothing about it.
    assert.ok(!mail.sent.some((m) => m.to === dave.email));
  });

  it("leaves out anyone who has left the workspace, and writes to a member's current address", async () => {
    const { ws, video } = await team();
    const note = await addComment(video.id, say("Check the captions."), ws.id, carol);
    await addComment(video.id, say("Looking.", note.id), ws.id, dave);
    await removeMember(ws.id, carol.id, alice);
    const current = (await getStore().get<typeof ws>("workspace", ws.id))!;
    await getStore().put("workspace", { ...current, members: current.members.map((m) => (m.userId === dave.id ? { ...m, email: "dave@new.example.com" } : m)) });
    const reply = await addComment(video.id, say("Fixed.", note.id), ws.id, bob);
    assert.equal(await notifyReply(reply), 1);
    assert.deepEqual(mail.sent.map((m) => m.to), ["dave@new.example.com"]);
  });

  it("does nothing for a note that starts a thread, in a personal space, or once the thread is gone", async () => {
    const { ws, video } = await team();
    const note = await addComment(video.id, say("A new note."), ws.id, alice);
    assert.equal(await notifyReply(note), 0);
    const mine = await createVideo(videoRequestSchema.parse({ title: "Mine", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), alice.id);
    const own = await addComment(mine.id, say("Note to self."), alice.id, alice);
    assert.equal(await notifyReply(await addComment(mine.id, say("Done.", own.id), alice.id, alice)), 0);
    const reply = await addComment(video.id, say("Seen.", note.id), ws.id, bob);
    await getStore().remove("comment", note.id);
    assert.equal(await notifyReply(reply), 0);
    assert.equal(mail.sent.length, 0);
  });

  it("opens the player at a pinned thread's moment", async () => {
    const { ws, video } = await team();
    await getStore().put<Video>("video", { ...(await getStore().get<Video>("video", video.id))!, status: "completed", provider: "heygen", durationSec: 90 });
    const note = await addComment(video.id, commentSchema.parse({ text: "This cut.", atSec: 65.4 }), ws.id, alice);
    const reply = await addComment(video.id, say("Smoothed it.", note.id), ws.id, bob);
    await notifyReply(reply);
    assert.ok(mail.sent[0].text.includes(`?ws=${ws.id}&t=65&comment=${note.id}`));
    assert.match(mail.sent[0].text, /on "Launch <teaser>" at 1:05:/, "the email names the thread's moment");
    assert.match(mail.sent[0].html, /<\/strong> at 1:05:/);
    await notifyMentions(await addComment(video.id, say("@carol@example.com see this", note.id), ws.id, bob));
    assert.match(mail.sent[1].text, /in a comment on "Launch <teaser>" at 1:05:/, "a mention in a reply names the thread's moment too");
    assert.ok(mail.sent[1].text.includes(`&t=65&comment=${note.id}`));
  });

  it("emails a mentioned member of the thread whose mention email did not go", async () => {
    const { ws, video } = await team();
    const note = await addComment(video.id, say("Thread."), ws.id, alice);
    await addComment(video.id, say("In.", note.id), ws.id, carol);
    mail.send = async (m) => {
      if (/mentioned you/.test(m.subject)) throw new Error("mailbox unavailable");
      mail.sent.push(m);
    };
    const reply = await addComment(video.id, say("@alice@example.com @dave@example.com done", note.id), ws.id, bob);
    const mailed = new Set<string>();
    assert.equal(await notifyMentions(reply, mailed), 0);
    assert.equal(mailed.size, 0);
    assert.equal(await notifyReply(reply, mailed), 2, "alice is in the thread; dave was only mentioned");
    assert.deepEqual(mail.sent.map((m) => m.to).sort(), [alice.email, carol.email]);
    // Once the mention reaches her, alice does not hear twice.
    mail.sent = [];
    mail.send = async (m) => void mail.sent.push(m);
    const again = await addComment(video.id, say("@alice@example.com one more", note.id), ws.id, bob);
    const reached = new Set<string>();
    await notifyMentions(again, reached);
    assert.deepEqual([...reached], [alice.id]);
    assert.equal(await notifyReply(again, reached), 1);
    assert.deepEqual(mail.sent.map((m) => `${m.to} ${/mentioned/.test(m.subject) ? "mention" : "reply"}`), [`${alice.email} mention`, `${carol.email} reply`]);
  });

  it("shares the hourly allowance with mention emails, and keeps going past one failed send", async () => {
    const { ws, video } = await team();
    const note = await addComment(video.id, say("Thread."), ws.id, alice);
    await addComment(video.id, say("In.", note.id), ws.id, carol);
    mail.send = async (m) => {
      if (m.to === alice.email) throw new Error("mailbox unavailable");
      mail.sent.push(m);
    };
    assert.equal(await notifyReply(await addComment(video.id, say("Me too.", note.id), ws.id, bob)), 1);
    assert.deepEqual(mail.sent.map((m) => m.to), [carol.email]);
    // Bob has used 2 of his emails this hour; mentions take the rest, and the next reply is posted but not emailed.
    const mentions = commentSchema.parse({ text: "@alice@example.com @carol@example.com again" });
    for (let i = 0; i < (MENTION_EMAILS_PER_HOUR - 2) / 2; i += 1) await notifyMentions(await addComment(video.id, mentions, ws.id, bob));
    const over = await addComment(video.id, say("One more.", note.id), ws.id, bob);
    assert.equal(over.parentId, note.id);
    assert.equal(await notifyReply(over), 0);
  });

  it("builds a thread's link: its workspace, a pinned moment in whole seconds, the thread, each part encoded", () => {
    assert.equal(threadLink("https://studio.example/", { id: "cmt_1", videoId: "vid_1", ownerId: "ws_a" }), "https://studio.example/videos/vid_1?ws=ws_a&comment=cmt_1");
    assert.equal(threadLink("https://studio.example", { id: "cmt 2", videoId: "v/2", ownerId: "ws_&b", atSec: 65.9 }), "https://studio.example/videos/v%2F2?ws=ws_%26b&t=65&comment=cmt%202");
    // A personal space's thread names no space; the page opens it in the one the reader is in.
    assert.equal(threadLink("https://studio.example", { id: "cmt_3", videoId: "vid_3", ownerId: "user_alice", atSec: 4 }), "https://studio.example/videos/vid_3?t=4&comment=cmt_3");
  });
});
