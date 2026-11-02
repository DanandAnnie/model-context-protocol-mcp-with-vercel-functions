// A share link scheduled to go live later: "not found" to the public (page, beacons, email) until its time, the
// owner keeping access, and never set to go live after it expires; and both times set on many videos at once.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { bulkVideoSchema, bulkVideos, createVideo, getVideo, recordView, updateVideo, videoPatchSchema, videoRequestSchema } from "../services";
import { inShareFilter, shareAttention, shareExpiresSoon, shareNotYet, shareOffline } from "../client";
import { getShareLock, shareCookieValue, shareUnlocked, verifySharePassword } from "../share-lock";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { batchLinkRows, filterVideos, videoQuerySchema } from "../services";
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

  it("sets the expiry of many videos at once, reporting the ones that go live at or after it and the ones not there", async () => {
    const [a, b, c] = [await readyVideo(), await readyVideo(), await readyVideo()];
    const end = inDays(10);
    await updateVideo(c.id, videoPatchSchema.parse({ shareStartsAt: end }), OWNER);
    assert.throws(() => bulkVideoSchema.parse({ action: "expire", ids: [a.id], shareExpiresAt: "2001-01-01T00:00:00Z" }), /in the future/);
    assert.throws(() => bulkVideoSchema.parse({ action: "expire", ids: [a.id], shareExpiresAt: "next week" }), /UTC offset/);
    const result = await bulkVideos(bulkVideoSchema.parse({ action: "expire", ids: [a.id, b.id, c.id, "vid_nosuch"], shareExpiresAt: end }), OWNER);
    assert.deepEqual(result, { done: 2, missing: ["vid_nosuch"], refused: [c.id] });
    // A go-live after the expiry is refused as one at the same time is.
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "expire", ids: [c.id], shareExpiresAt: inDays(9) }), OWNER), { done: 0, missing: [], refused: [c.id] });
    assert.deepEqual([(await getVideo(a.id, OWNER, false)).shareExpiresAt, (await getVideo(b.id, OWNER, false)).shareExpiresAt], [end, end]);
    assert.equal("shareExpiresAt" in (await getVideo(c.id, OWNER, false)), false, "a video going live at that time keeps its link as it was");
    // Still live until then, and open indefinitely again in one request.
    assert.equal((await getVideo(a.id, null, false)).id, a.id);
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "expire", ids: [a.id, b.id], shareExpiresAt: null }), OWNER), { done: 2, missing: [], refused: [] });
    assert.equal("shareExpiresAt" in (await getVideo(a.id, OWNER, false)), false);
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "expire", ids: [a.id], shareExpiresAt: end }), "someone_else"), { done: 0, missing: [a.id], refused: [] });
  });

  it("puts one password on many videos' links at once, each its own lock, and removes them in one step", async () => {
    const [a, b] = [await readyVideo(), await readyVideo()];
    assert.throws(() => bulkVideoSchema.parse({ action: "password", ids: [a.id], sharePassword: "abc" }), /at least 4/);
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "password", ids: [a.id, b.id, "vid_nosuch"], sharePassword: "  launch day  " }), OWNER), { done: 2, missing: ["vid_nosuch"] });
    for (const v of [a, b]) assert.equal((await getVideo(v.id, OWNER, false)).shareLocked, true);
    // Each video keeps its own salted lock; the trimmed password opens both, and nothing of it is on the video.
    const [la, lb] = [await getShareLock(a.id), await getShareLock(b.id)];
    assert.ok(la && lb && la.salt !== lb.salt);
    assert.ok(await verifySharePassword(a.id, "launch day"));
    assert.ok(await verifySharePassword(b.id, "launch day"));
    assert.equal(JSON.stringify(await getVideo(a.id, OWNER, false)).includes("launch"), false);
    // Protecting again, even with the same password, rotates the lock, so a visitor's earlier unlock no longer opens it.
    const cookie = shareCookieValue(la);
    assert.equal(await shareUnlocked(await getVideo(a.id, OWNER, false), cookie), true);
    await bulkVideos(bulkVideoSchema.parse({ action: "password", ids: [a.id], sharePassword: "launch day" }), OWNER);
    assert.equal(await shareUnlocked(await getVideo(a.id, OWNER, false), cookie), false);
    // The server holds the bounds after trimming, whatever the page checked.
    assert.throws(() => bulkVideoSchema.parse({ action: "password", ids: [a.id], sharePassword: "      " }), /at least 4/);
    assert.throws(() => bulkVideoSchema.parse({ action: "password", ids: [a.id], sharePassword: "x".repeat(65) }), /at most 64/);
    assert.equal(bulkVideoSchema.safeParse({ action: "password", ids: [a.id], sharePassword: ` ${"x".repeat(64)} ` }).success, true);
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "password", ids: [a.id, b.id], sharePassword: null }), OWNER), { done: 2, missing: [] });
    assert.equal("shareLocked" in (await getVideo(a.id, OWNER, false)), false);
    assert.equal(await getShareLock(b.id), null);
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "password", ids: [a.id], sharePassword: "letmein" }), "someone_else"), { done: 0, missing: [a.id] });
  });

  it("turns the download button and email gate on or off for many videos, leaving out a setting not asked for", async () => {
    const [a, b] = [await readyVideo(), await readyVideo()];
    assert.throws(() => bulkVideoSchema.parse({ action: "settings", ids: [a.id] }), /Choose a setting/);
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "settings", ids: [a.id, b.id, "vid_nosuch"], shareDownload: true, shareGate: true }), OWNER), { done: 2, missing: ["vid_nosuch"] });
    for (const v of [a, b]) {
      const got = await getVideo(v.id, OWNER, false);
      assert.deepEqual([got.shareDownload, got.shareGate], [true, true]);
    }
    // Only the gate goes off; the download button stays on.
    await bulkVideos(bulkVideoSchema.parse({ action: "settings", ids: [a.id, b.id], shareGate: false }), OWNER);
    const after = await getVideo(a.id, OWNER, false);
    assert.equal(after.shareDownload, true);
    assert.equal("shareGate" in after, false);
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "settings", ids: [a.id], shareDownload: false }), "someone_else"), { done: 0, missing: [a.id] });
    // Both in one request, one on and one off; the link's other settings are left alone.
    await updateVideo(b.id, videoPatchSchema.parse({ shareDisabled: true, sharePassword: "keep me", shareStartsAt: inDays(3) }), OWNER);
    await bulkVideos(bulkVideoSchema.parse({ action: "settings", ids: [b.id], shareDownload: false, shareGate: true }), OWNER);
    const both = await getVideo(b.id, OWNER, false);
    assert.equal("shareDownload" in both, false, "off removes it");
    assert.equal(both.shareGate, true);
    assert.deepEqual([both.shareDisabled, both.shareLocked, typeof both.shareStartsAt], [true, true, "string"]);
  });

  it("points out a live link's expiry only within a week, and not for a link the public cannot reach", () => {
    const now = Date.parse("2030-06-01T12:00:00Z");
    const at = (ms: number) => new Date(now + ms).toISOString();
    assert.equal(shareExpiresSoon({}, now), undefined, "no expiry");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(10 * 60_000) }, now), "Expires in 1 hour", "minutes away reads in hours, not as a day");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(5 * 3_600_000 + 1) }, now), "Expires in 6 hours");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(86_400_000) }, now), "Expires in 1 day");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(3 * 86_400_000) }, now), "Expires in 3 days");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(6 * 86_400_000 + 1) }, now), "Expires in 7 days", "rounded up");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(7 * 86_400_000) }, now), "Expires in 7 days");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(2 * 86_400_000), shareStartsAt: at(-3_600_000) }, now), "Expires in 2 days", "went live already");
    assert.equal(shareExpiresSoon({ shareExpiresAt: "not a time" }, now), undefined, "unreadable");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(7 * 86_400_000 + 1) }, now), undefined, "more than a week away");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(0) }, now), undefined, "already expired");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(86_400_000), shareDisabled: true }, now), undefined, "switched off");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(2 * 86_400_000), shareStartsAt: at(86_400_000) }, now), undefined, "not live yet");
    assert.equal(shareExpiresSoon({ shareExpiresAt: at(86_400_000), deletedAt: at(-1) }, now), undefined, "in the trash");
  });

  it("counts the links to check as the library's expiring and expired filters list them", () => {
    const now = Date.parse("2030-06-01T12:00:00Z");
    const at = (ms: number) => new Date(now + ms).toISOString();
    const videos = [
      { shareExpiresAt: at(2 * 86_400_000) },
      { shareExpiresAt: at(3_600_000) },
      { shareExpiresAt: at(8 * 86_400_000) },
      { shareExpiresAt: at(-1) },
      { shareExpiresAt: at(-86_400_000), shareDisabled: true },
      { shareExpiresAt: at(86_400_000), shareDisabled: true },
      { shareExpiresAt: at(86_400_000), deletedAt: at(-1) },
      { shareExpiresAt: at(-1), deletedAt: at(-1) },
      { shareExpiresAt: at(2 * 86_400_000), shareStartsAt: at(86_400_000) },
      {},
    ];
    assert.deepEqual(shareAttention(videos, now), { expiring: 2, expired: 1 }, "off, in the trash, not live yet, and far off are left out");
    assert.deepEqual(shareAttention([], now), { expiring: 0, expired: 0 });
    // The server's filter, by its own clock: the same videos, as stored ones, with times counted from the real now.
    const real = Date.now();
    const stored = videos.map((v, i) => ({ id: `v${i}`, title: `V${i}`, createdAt: new Date(real).toISOString(), ...Object.fromEntries(Object.entries(v).map(([k, t]) => [k, typeof t === "string" ? new Date(Date.parse(t) - now + real).toISOString() : t])) }) as unknown as Video);
    for (const share of ["expiring", "expired"] as const) {
      assert.equal(filterVideos(stored, videoQuerySchema.parse({ share })).length, shareAttention(stored, real)[share], share);
    }
    assert.equal(inShareFilter({ shareExpiresAt: at(-1) }, "expired", now), true);
    assert.equal(inShareFilter({ shareDisabled: true, deletedAt: at(-1) }, "off", now), false, "a trashed link is in no state");
    assert.equal(inShareFilter({ shareStartsAt: at(1) }, "scheduled", now), true);
    assert.equal(inShareFilter({}, "live", now), true);
  });
});
