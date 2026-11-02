// One cover picture for many videos at once: each video keeps its own copy, in place of any it had, removed with null,
// held to the same rules as on one video, and sending an approved video back to not reviewed as that does.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { getCover } from "../cover";
import { bulkVideoSchema, bulkVideos, createVideo, getVideo, updateVideo, videoPatchSchema, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { BULK_MAX, type Video } from "../types";

const OWNER = "user_bulk_cover";
const approved = { review: { status: "approved", requestedById: "u", requestedAt: new Date().toISOString() } } as Partial<Video>;
// A 1×1 PNG (70 bytes) and a 1×1 GIF (42 bytes), so a replaced cover is told apart from the new one.
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

async function video(title: string, patch: Partial<Video> = {}, owner = OWNER): Promise<Video> {
  const v = await createVideo(videoRequestSchema.parse({ title, avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Doors open Saturday." }), owner);
  return getStore().put("video", { ...v, status: "completed" as const, ...patch });
}

describe("bulk cover", () => {
  it("gives every video its own copy of one picture, in place of the cover a video had", async () => {
    const a = await video("Open house");
    const b = await updateVideo((await video("Tour")).id, videoPatchSchema.parse({ cover: gif }), OWNER);
    assert.equal(b.cover?.mimeType, "image/gif");
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "cover", ids: [a.id, b.id], cover: png }), OWNER), { done: 2, missing: [] });
    for (const id of [a.id, b.id]) {
      const v = await getVideo(id, OWNER);
      assert.equal(v.cover?.mimeType, "image/png");
      assert.equal(v.cover?.bytes, 70);
      assert.deepEqual({ width: v.cover?.width, height: v.cover?.height }, { width: 1, height: 1 });
      const stored = await getCover(id);
      assert.equal(stored?.mimeType, "image/png");
      assert.equal(stored?.bytes.byteLength, 70, "each video's own record holds the picture");
    }
    // Removing one video's cover later leaves the others' copies as they are.
    await updateVideo(a.id, videoPatchSchema.parse({ cover: null }), OWNER);
    assert.equal(await getCover(a.id), null);
    assert.equal((await getCover(b.id))?.bytes.byteLength, 70);
  });

  it("removes the covers with null, a video with none included", async () => {
    const a = await updateVideo((await video("One")).id, videoPatchSchema.parse({ cover: png }), OWNER);
    const b = await video("Two");
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "cover", ids: [a.id, b.id], cover: null }), OWNER), { done: 2, missing: [] });
    for (const id of [a.id, b.id]) {
      assert.equal("cover" in (await getVideo(id, OWNER)), false);
      assert.equal(await getCover(id), null);
    }
  });

  it("sends an approved video back to not reviewed, as a cover changes what its share page shows", async () => {
    const v = await video("Approved", approved);
    await bulkVideos(bulkVideoSchema.parse({ action: "cover", ids: [v.id], cover: png }), OWNER);
    assert.equal((await getVideo(v.id, OWNER)).review, undefined);
  });

  it("keeps the approval of a video with no cover to remove, and drops it where a cover goes", async () => {
    const bare = await video("No cover", approved);
    const covered = await getStore().put("video", { ...(await updateVideo((await video("Covered")).id, videoPatchSchema.parse({ cover: png }), OWNER)), ...approved });
    assert.equal((await getVideo(covered.id, OWNER)).review?.status, "approved");
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "cover", ids: [bare.id, covered.id], cover: null }), OWNER), { done: 2, missing: [] });
    assert.equal((await getVideo(bare.id, OWNER)).review?.status, "approved", "nothing its share page shows changed");
    assert.equal((await getVideo(covered.id, OWNER)).review, undefined, "its share page lost the cover");
  });

  it("reports the videos that are not there or are someone else's, and writes the rest", async () => {
    const mine = await video("Mine");
    const theirs = await video("Theirs", {}, "someone_else");
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "cover", ids: [mine.id, theirs.id, "vid_gone"], cover: png }), OWNER), { done: 1, missing: [theirs.id, "vid_gone"] });
    assert.equal((await getStore().get<Video>("video", theirs.id))?.cover, undefined);
    assert.equal(await getCover(theirs.id), null);
  });

  it("refuses a picture the server cannot keep before any video is written", async () => {
    const a = await video("First");
    const b = await video("Second");
    for (const [cover, message] of [
      ["data:image/svg+xml;base64,PHN2Zy8+", /PNG, JPEG, WebP, or GIF/],
      ["data:image/png;base64", /malformed/],
    ] as const) {
      await assert.rejects(bulkVideos(bulkVideoSchema.parse({ action: "cover", ids: [a.id, b.id], cover }), OWNER), message);
      for (const id of [a.id, b.id]) {
        assert.equal((await getVideo(id, OWNER)).cover, undefined);
        assert.equal(await getCover(id), null);
      }
    }
  });

  it("holds the picture to the rules a single video's cover has", () => {
    const parse = (cover: unknown, ids = ["vid_1"]) => bulkVideoSchema.safeParse({ action: "cover", ids, cover }).success;
    assert.equal(parse(png), true);
    assert.equal(parse(null), true);
    assert.equal(parse(undefined), false, "a picture or null is needed");
    assert.equal(parse(png, []), false);
    assert.equal(parse(png, Array.from({ length: BULK_MAX + 1 }, (_, i) => `vid_${i}`)), false);
    for (const value of [png, null, "https://example.com/a.png", `data:image/png;base64,${"A".repeat(3_000_001)}`]) {
      assert.equal(parse(value), videoPatchSchema.safeParse({ cover: value }).success, String(value).slice(0, 40));
    }
  });
});
