// Starred videos: a mark to find a video again, set on one or many, kept through the trash, and never a change to
// what the share page shows. Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { bulkVideoSchema, bulkVideos, createVideo, deleteVideo, filterVideos, getVideo, restoreVideo, retryVideo, updateVideo, videoPatchSchema, videoQuerySchema, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import type { Video } from "../types";

const OWNER = "user_starred";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

async function video(title: string, patch: Partial<Video> = {}): Promise<Video> {
  const v = await createVideo(videoRequestSchema.parse({ title, avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Doors open Saturday." }), OWNER);
  return getStore().put("video", { ...v, status: "completed" as const, ...patch });
}

describe("starred videos", () => {
  it("stars and unstars one video, keeping its review approval", async () => {
    const v = await video("Tour", { review: { status: "approved", requestedById: "u", requestedAt: new Date().toISOString() } } as Partial<Video>);
    const starred = await updateVideo(v.id, videoPatchSchema.parse({ starred: true }), OWNER);
    assert.equal(starred.starred, true);
    assert.equal(starred.review?.status, "approved", "a star is not part of what the share page shows");
    const off = await updateVideo(v.id, videoPatchSchema.parse({ starred: false }), OWNER);
    assert.equal("starred" in off, false, "no key is kept for an unstarred video");
    assert.equal(videoPatchSchema.safeParse({ starred: "yes" }).success, false);
  });

  it("keeps a star set while a slower edit of the same video was under way, and the other way round", async () => {
    const v = await video("Busy");
    // A password is hashed before it is written, so this edit read the video before the star landed.
    const slow = updateVideo(v.id, videoPatchSchema.parse({ sharePassword: "open sesame" }), OWNER);
    await updateVideo(v.id, videoPatchSchema.parse({ starred: true }), OWNER);
    const after = await slow;
    assert.deepEqual([after.starred, after.shareLocked], [true, true]);
    const slowOff = updateVideo(v.id, videoPatchSchema.parse({ sharePassword: null }), OWNER);
    await updateVideo(v.id, videoPatchSchema.parse({ starred: false }), OWNER);
    assert.equal((await slowOff).starred, undefined, "nor does it put back a star taken off meanwhile");
  });

  it("a retry of a starred failed render is starred too, as it stands in for it", async () => {
    const failed = await video("Failed", { status: "failed", error: "boom", starred: true });
    assert.equal((await retryVideo(failed.id, OWNER)).starred, true);
  });

  it("filters the library to the starred videos, with the other filters", async () => {
    const a = await video("Starred open house", { starred: true });
    await video("Plain open house");
    const b = await video("Starred listing", { starred: true, status: "failed" });
    const all = await getStore().list<Video>("video", OWNER);
    const ids = (q: Record<string, string>) => filterVideos(all, videoQuerySchema.parse(q)).map((v) => v.id).sort();
    assert.deepEqual(ids({ starred: "1" }), [a.id, b.id].sort());
    assert.deepEqual(ids({ starred: "true", q: "open house" }), [a.id]);
    assert.deepEqual(ids({ starred: "1", status: "failed" }), [b.id]);
    assert.equal(ids({}).length, 3, "absent means every video");
    assert.equal(ids({ starred: "0" }).length, 3);
  });

  it("stars many at once, reporting the ones not there, and keeps a star through the trash", async () => {
    const a = await video("One");
    const b = await video("Two");
    const theirs = await createVideo(videoRequestSchema.parse({ title: "Theirs", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Hi." }), "someone_else");
    const r = await bulkVideos(bulkVideoSchema.parse({ action: "star", ids: [a.id, b.id, a.id, theirs.id, "vid_nope"], starred: true }), OWNER);
    assert.deepEqual([r.done, r.missing], [2, [theirs.id, "vid_nope"]]);
    assert.equal((await getVideo(b.id, OWNER)).starred, true);
    assert.equal((await getStore().get<Video>("video", theirs.id))?.starred, undefined);
    await deleteVideo(a.id, OWNER);
    await restoreVideo(a.id, OWNER);
    assert.equal((await getVideo(a.id, OWNER)).starred, true);
    const off = await bulkVideos(bulkVideoSchema.parse({ action: "star", ids: [a.id, b.id], starred: false }), OWNER);
    assert.equal(off.done, 2);
    assert.equal((await getVideo(a.id, OWNER)).starred, undefined);
    assert.equal(bulkVideoSchema.safeParse({ action: "star", ids: [a.id] }).success, false, "starred is required");
  });
});
