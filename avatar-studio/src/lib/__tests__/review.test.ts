// Video review and approval in a workspace.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createVideo, filterVideos, getVideo, reviewActionSchema, reviewVideo, videoQuerySchema, videoRequestSchema } from "../services";
import { describeActivity } from "../activity-text";
import { canManageAccount, createWorkspace } from "../workspaces";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { ActivityEvent } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const alice = { id: "user_alice", email: "alice@example.com" };
const bob = { id: "user_bob", email: "bob@example.com" };
const act = (action: "request" | "approve" | "changes" | "withdraw", note?: string) => reviewActionSchema.parse({ action, ...(note ? { note } : {}) });

async function teamVideo() {
  const ws = await createWorkspace("Acme", alice);
  const video = await createVideo(videoRequestSchema.parse({ title: "Launch teaser", script: "Hello team.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), ws.id);
  return { ws, video };
}

describe("video review", () => {
  it("an editor asks, an owner approves, and the decision is kept with who made it", async () => {
    const { ws, video } = await teamVideo();
    assert.equal(canManageAccount(ws, alice.id), true);
    const asked = await reviewVideo(video.id, ws.id, bob, false, act("request", "Ready for the launch email"));
    assert.deepEqual([asked.review?.status, asked.review?.requestedByEmail, asked.review?.note], ["pending", "bob@example.com", "Ready for the launch email"]);
    await assert.rejects(reviewVideo(video.id, ws.id, bob, false, act("request")), /already pending/);
    // Only an owner decides.
    await assert.rejects(reviewVideo(video.id, ws.id, bob, false, act("approve")), /Only workspace owners/);
    const approved = await reviewVideo(video.id, ws.id, alice, true, act("approve"));
    assert.deepEqual([approved.review?.status, approved.review?.decidedByEmail, approved.review?.note], ["approved", "alice@example.com", "Ready for the launch email"]);
    assert.ok(approved.review?.decidedAt);
    // A decided review cannot be decided again without a new request.
    await assert.rejects(reviewVideo(video.id, ws.id, alice, true, act("changes", "Shorter intro")), /Ask for a review first/);
    assert.equal((await getVideo(video.id, ws.id, false)).review?.status, "approved");
  });

  it("asking for changes needs a note, and a new request starts over", async () => {
    const { ws, video } = await teamVideo();
    await reviewVideo(video.id, ws.id, bob, false, act("request"));
    assert.equal(reviewActionSchema.safeParse({ action: "changes" }).success, false, "a change request says what to change");
    const changes = await reviewVideo(video.id, ws.id, alice, true, act("changes", "Use the new logo"));
    assert.deepEqual([changes.review?.status, changes.review?.note], ["changes", "Use the new logo"]);
    const again = await reviewVideo(video.id, ws.id, bob, false, act("request"));
    assert.equal(again.review?.status, "pending");
    assert.equal(again.review?.decidedById, undefined, "the old decision does not linger on a new request");
    assert.equal(again.review?.note, undefined);
  });

  it("only the person who asked, or an owner, withdraws a pending review", async () => {
    const { ws, video } = await teamVideo();
    await reviewVideo(video.id, ws.id, bob, false, act("request"));
    const carol = { id: "user_carol" };
    await assert.rejects(reviewVideo(video.id, ws.id, carol, false, act("withdraw")), /Only the person who asked/);
    const withdrawn = await reviewVideo(video.id, ws.id, bob, false, act("withdraw"));
    assert.equal(withdrawn.review, undefined);
    await assert.rejects(reviewVideo(video.id, ws.id, bob, false, act("withdraw")), /no pending review/);
  });

  it("is refused in a personal space, for another owner's video, and in the trash", async () => {
    const personal = await createVideo(videoRequestSchema.parse({ title: "Mine", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), alice.id);
    await assert.rejects(reviewVideo(personal.id, alice.id, alice, false, act("request")), /Reviews are for workspace videos/);
    const { ws, video } = await teamVideo();
    const other = await createWorkspace("Other", bob);
    await assert.rejects(reviewVideo(video.id, other.id, bob, true, act("request")), /not found/);
    const { deleteVideo } = await import("../services");
    await deleteVideo(video.id, ws.id);
    await assert.rejects(reviewVideo(video.id, ws.id, bob, false, act("request")), /Restore the video/);
  });

  it("an owner edit in flight keeps a review that landed meanwhile", async () => {
    const { updateVideo, videoPatchSchema } = await import("../services");
    const { ws, video } = await teamVideo();
    // The password edit reads the record, then hashes before it writes; the review lands in between.
    const edit = updateVideo(video.id, videoPatchSchema.parse({ sharePassword: "secret12" }), ws.id);
    await reviewVideo(video.id, ws.id, bob, false, act("request"));
    const edited = await edit;
    assert.equal(edited.shareLocked, true);
    assert.equal(edited.review?.status, "pending", "the edit does not write its pre-review copy over the request");
  });

  it("the library filters by review state, and the feed names each step", async () => {
    const { ws, video } = await teamVideo();
    const untouched = await createVideo(videoRequestSchema.parse({ title: "Untouched", script: "Hi.", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id }), ws.id);
    const pending = await reviewVideo(video.id, ws.id, bob, false, act("request"));
    const all = [pending, untouched];
    assert.deepEqual(filterVideos(all, videoQuerySchema.parse({ review: "pending" })).map((v) => v.id), [video.id]);
    assert.deepEqual(filterVideos(all, videoQuerySchema.parse({ review: "none" })).map((v) => v.id), [untouched.id]);
    assert.equal(videoQuerySchema.safeParse({ review: "maybe" }).success, false);
    const event = (kind: ActivityEvent["kind"]): ActivityEvent => ({ id: "a", ownerId: ws.id, kind, actorId: bob.id, actorEmail: bob.email, subject: "Launch teaser", createdAt: "" });
    assert.equal(describeActivity(event("video.review_requested")), 'bob@example.com asked for a review of "Launch teaser"');
    assert.equal(describeActivity(event("video.approved"), bob.id), 'You approved "Launch teaser"');
    assert.equal(describeActivity(event("video.changes_requested")), 'bob@example.com asked for changes to "Launch teaser"');
  });
});
