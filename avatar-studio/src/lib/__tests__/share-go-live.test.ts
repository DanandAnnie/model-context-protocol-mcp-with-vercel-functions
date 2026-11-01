// A share link scheduled to go live later: "not found" to the public (page, beacons, email) until its time, the
// owner keeping access, and never set to go live after it expires. Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { bulkVideoSchema, bulkVideos, createVideo, getVideo, recordView, updateVideo, videoPatchSchema, videoRequestSchema } from "../services";
import { shareNotYet, shareOffline } from "../client";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { batchLinkRows } from "../services";
import type { Video } from "../types";

const OWNER = "user_go_live";
// Times always ahead of the clock: in N days, at the same instant.
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

async function readyVideo(): Promise<Video> {
  const v = await createVideo(videoRequestSchema.parse({ title: "Launch", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Doors open Saturday." }), OWNER);
  const ready = { ...(await getVideo(v.id, OWNER, false)), status: "completed" as const };
  await getStore().put("video", ready);
  return ready;
}

describe("share link go-live time", () => {
  it("keeps the link offline to the public until its time, and the owner sees it throughout", async () => {
    const v = await readyVideo();
    assert.throws(() => videoPatchSchema.parse({ shareStartsAt: "2001-01-01T00:00:00Z" }), /in the future/);
    assert.throws(() => videoPatchSchema.parse({ shareStartsAt: inDays(30).slice(0, 16) }), /UTC offset/);
    // An offset is kept as the same instant in UTC.
    const at = new Date(Date.parse(inDays(30)));
    at.setUTCSeconds(0, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    const shifted = new Date(at.getTime() + 2 * 3_600_000);
    const withOffset = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:00+02:00`;
    const scheduled = await updateVideo(v.id, videoPatchSchema.parse({ shareStartsAt: withOffset }), OWNER);
    assert.equal(scheduled.shareStartsAt, at.toISOString(), "stored as a UTC instant");
    assert.equal(shareNotYet(scheduled), true);
    assert.equal(shareOffline(scheduled, at.getTime() + 1), false, "the helper takes a clock");
    await assert.rejects(getVideo(v.id, null, false), /not found/, "not public before its time");
    await assert.rejects(recordView(v.id), /not found/, "beacons answer like the share page");
    assert.equal((await getVideo(v.id, OWNER, false)).id, v.id, "the owner keeps access");
    assert.equal(batchLinkRows([scheduled], "https://s")[0].share_link, undefined, "a batch link is left blank until it goes live");
    // The time comes (the stored instant moves behind the clock rather than the test waiting).
    await getStore().put("video", { ...(await getVideo(v.id, OWNER, false)), shareStartsAt: new Date(Date.now() - 1).toISOString() });
    assert.equal((await getVideo(v.id, null, false)).id, v.id, "public once its time has passed");
    assert.deepEqual(await recordView(v.id), { views: 1, counted: true });
    const cleared = await updateVideo(v.id, videoPatchSchema.parse({ shareStartsAt: null }), OWNER);
    assert.equal("shareStartsAt" in cleared, false);
  });

  it("never goes live at or after the link's expiry, whichever of the two is moved", async () => {
    const v = await readyVideo();
    await updateVideo(v.id, videoPatchSchema.parse({ shareExpiresAt: inDays(60) }), OWNER);
    await assert.rejects(updateVideo(v.id, videoPatchSchema.parse({ shareStartsAt: inDays(60) }), OWNER), /go live before it expires/);
    await updateVideo(v.id, videoPatchSchema.parse({ shareStartsAt: inDays(50) }), OWNER);
    await assert.rejects(updateVideo(v.id, videoPatchSchema.parse({ shareExpiresAt: inDays(40) }), OWNER), /go live before it expires/);
    await assert.rejects(updateVideo(v.id, videoPatchSchema.parse({ shareStartsAt: inDays(80), shareExpiresAt: inDays(70) }), OWNER), /go live before it expires/);
    const start = inDays(70);
    const end = inDays(80);
    const both = await updateVideo(v.id, videoPatchSchema.parse({ shareStartsAt: start, shareExpiresAt: end }), OWNER);
    assert.deepEqual([both.shareStartsAt, both.shareExpiresAt], [start, end]);
    // Clearing the expiry leaves the go-live time on its own.
    assert.equal((await updateVideo(v.id, videoPatchSchema.parse({ shareExpiresAt: null }), OWNER)).shareStartsAt, start);
  });

  it("schedules many videos at once, reporting the ones whose own expiry comes first and the ones not there", async () => {
    const [a, b, c] = [await readyVideo(), await readyVideo(), await readyVideo()];
    await updateVideo(c.id, videoPatchSchema.parse({ shareExpiresAt: inDays(5) }), OWNER);
    assert.throws(() => bulkVideoSchema.parse({ action: "schedule", ids: [a.id], shareStartsAt: "2001-01-01T00:00:00Z" }), /in the future/);
    const at = inDays(10);
    const result = await bulkVideos(bulkVideoSchema.parse({ action: "schedule", ids: [a.id, b.id, c.id, "vid_nosuch"], shareStartsAt: at }), OWNER);
    assert.deepEqual(result, { done: 2, missing: ["vid_nosuch"], refused: [c.id] });
    assert.deepEqual([(await getVideo(a.id, OWNER, false)).shareStartsAt, (await getVideo(b.id, OWNER, false)).shareStartsAt], [at, at]);
    assert.equal("shareStartsAt" in (await getVideo(c.id, OWNER, false)), false, "a video whose expiry comes first keeps its link as it was");
    await assert.rejects(getVideo(a.id, null, false), /not found/);
    // Live now again, in one request.
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "schedule", ids: [a.id, b.id], shareStartsAt: null }), OWNER), { done: 2, missing: [], refused: [] });
    assert.equal((await getVideo(a.id, null, false)).id, a.id);
    // Another owner's video is not touched.
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "schedule", ids: [a.id], shareStartsAt: at }), "someone_else"), { done: 0, missing: [a.id], refused: [] });
  });
});
