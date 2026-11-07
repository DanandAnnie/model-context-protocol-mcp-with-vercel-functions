// One call-to-action button for the share pages of many videos at once: set in place of any each had, removed with
// null, held to the same rules as on one video, and sending an approved video back to not reviewed as that does.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { bulkVideoSchema, bulkVideos, createVideo, getVideo, videoPatchSchema, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { BULK_MAX, SHARE_CTA_LABEL_MAX, SHARE_CTA_URL_MAX, type Video } from "../types";

const OWNER = "user_bulk_cta";
const approved = { review: { status: "approved", requestedById: "u", requestedAt: new Date().toISOString() } } as Partial<Video>;

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

async function video(title: string, patch: Partial<Video> = {}, owner = OWNER): Promise<Video> {
  const v = await createVideo(videoRequestSchema.parse({ title, avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Doors open Saturday." }), owner);
  return getStore().put("video", { ...v, status: "completed" as const, ...patch });
}
const cta = { label: "Book a viewing", url: "https://example.com/book" };

describe("bulk call to action", () => {
  it("puts one button on every video, in place of the one a video had", async () => {
    const a = await video("Open house");
    const b = await video("Tour", { shareCta: { label: "Old", url: "https://example.com/old" }, ctaClicks: 3 } as Partial<Video>);
    const result = await bulkVideos(bulkVideoSchema.parse({ action: "cta", ids: [a.id, b.id], shareCta: { label: "  Book a viewing ", url: " https://example.com/book " } }), OWNER);
    assert.deepEqual(result, { done: 2, missing: [] });
    for (const id of [a.id, b.id]) assert.deepEqual((await getVideo(id, OWNER)).shareCta, cta, "trimmed as on one video");
    assert.equal(((await getVideo(b.id, OWNER)) as Video & { ctaClicks?: number }).ctaClicks, 3, "the clicks counted so far are kept, as on one video");
  });

  it("removes the buttons with null", async () => {
    const a = await video("One", { shareCta: cta });
    const b = await video("Two");
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "cta", ids: [a.id, b.id], shareCta: null }), OWNER), { done: 2, missing: [] });
    assert.equal("shareCta" in (await getVideo(a.id, OWNER)), false);
    assert.equal("shareCta" in (await getVideo(b.id, OWNER)), false);
  });

  it("sends an approved video back to not reviewed only when its button changes", async () => {
    const changed = await video("Changed", approved);
    const same = await video("Same", { ...approved, shareCta: cta });
    await bulkVideos(bulkVideoSchema.parse({ action: "cta", ids: [changed.id, same.id], shareCta: cta }), OWNER);
    assert.equal((await getVideo(changed.id, OWNER)).review, undefined, "what the share page shows changed");
    assert.equal((await getVideo(same.id, OWNER)).review?.status, "approved", "the same button is no change");
  });

  it("reports the videos that are not there or are someone else's, and writes the rest", async () => {
    const mine = await video("Mine");
    const theirs = await video("Theirs", {}, "someone_else");
    const result = await bulkVideos(bulkVideoSchema.parse({ action: "cta", ids: [mine.id, theirs.id, "vid_gone"], shareCta: cta }), OWNER);
    assert.deepEqual(result, { done: 1, missing: [theirs.id, "vid_gone"] });
    assert.equal((await getStore().get<Video>("video", theirs.id))?.shareCta, undefined);
  });

  it("holds the button to the rules a single video's has", () => {
    const parse = (shareCta: unknown, ids = ["vid_1"]) => bulkVideoSchema.safeParse({ action: "cta", ids, shareCta }).success;
    assert.equal(parse(cta), true);
    assert.equal(parse({ label: "x".repeat(SHARE_CTA_LABEL_MAX), url: cta.url }), true);
    assert.equal(parse({ label: "x".repeat(SHARE_CTA_LABEL_MAX + 1), url: cta.url }), false);
    assert.equal(parse({ label: "   ", url: cta.url }), false);
    assert.equal(parse({ label: "Go", url: "javascript:alert(1)" }), false);
    assert.equal(parse({ label: "Go", url: "example.com" }), false);
    assert.equal(parse({ label: "Go", url: "https://a b" }), false, "a space inside the link");
    assert.equal(parse({ label: "Go", url: `https://example.com/${"x".repeat(SHARE_CTA_URL_MAX)}` }), false);
    assert.equal(parse({ label: "  Go  ", url: " https://example.com " }), true, "spaces around either are trimmed");
    assert.equal(parse(undefined), false, "a button or null is needed");
    assert.equal(parse(cta, []), false);
    assert.equal(parse(cta, Array.from({ length: BULK_MAX + 1 }, (_, i) => `vid_${i}`)), false);
    for (const value of [cta, { label: "x".repeat(SHARE_CTA_LABEL_MAX + 1), url: cta.url }, { label: "Go", url: "ftp://x" }, null]) {
      assert.equal(parse(value), videoPatchSchema.safeParse({ shareCta: value }).success, JSON.stringify(value));
    }
  });
});
