// Tags on videos: tidied and held to their limits, kept and removed through an update, filtered and searched in the
// library, counted for its filter, and carried to a retry.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { bulkVideoSchema, bulkVideos, createVideo, filterVideos, getVideo, queryVideos, updateVideo, videoPatchSchema, videoQuerySchema, videoRequestSchema } from "../services";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";
import { VIDEO_TAGS_MAX, VIDEO_TAG_MAX, cleanTags, countTags, retagged, sameTag, tagsProblem } from "../tags";
import type { Video } from "../types";

const OWNER = "user_video_tags";
const made = (id: string, patch: Partial<Video> = {}) =>
  ({ id, title: `Tour ${id}`, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", createdAt: `2026-11-0${id.length}T10:00:00.000Z`, updatedAt: "2026-11-08T10:00:00.000Z", ...patch }) as Video;

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

describe("tag rules", () => {
  it("tidies tags and keeps one of each, case aside, in its first spelling", () => {
    assert.deepEqual(cleanTags(["  open   house ", "Open House", "", "  ", "Spring"]), ["open house", "Spring"]);
    assert.ok(sameTag("Spring", "SPRING"));
    assert.ok(!sameTag("cafe", "café"));
  });

  it("says why tags cannot be kept", () => {
    assert.equal(tagsProblem(["a", "b"]), null);
    assert.match(tagsProblem(Array.from({ length: VIDEO_TAGS_MAX + 1 }, (_, i) => `t${i}`))!, /at most 10 tags/);
    assert.match(tagsProblem(["x".repeat(VIDEO_TAG_MAX + 1)])!, /at most 24 characters/);
    // Counted in characters, so an emoji tag at the limit is fine.
    assert.equal(tagsProblem(["é".repeat(VIDEO_TAG_MAX)]), null);
  });

  it("counts tags across videos, most used first, named as the newest video spelled them", () => {
    const counts = countTags([
      { tags: ["spring", "Tour"], createdAt: "2026-11-01" },
      { tags: ["Spring"], createdAt: "2026-11-05" },
      { tags: ["tour", "Listing 10"], createdAt: "2026-11-02" },
      { tags: ["Listing 9"], createdAt: "2026-11-03" },
      { createdAt: "2026-11-04" },
    ]);
    assert.deepEqual(counts, [
      { name: "Spring", count: 2 },
      { name: "tour", count: 2 },
      { name: "Listing 9", count: 1 },
      { name: "Listing 10", count: 1 },
    ]);
  });
});

describe("tags on a video", () => {
  const request = (title: string) => videoRequestSchema.parse({ title, avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Doors open Saturday." });

  it("are kept by an update and removed with an empty list", async () => {
    const v = await createVideo(request("Tagged"), OWNER);
    const tagged = await updateVideo(v.id, videoPatchSchema.parse({ tags: [" Open  house", "spring", "open house"] }), OWNER);
    assert.deepEqual(tagged.tags, ["Open house", "spring"]);
    assert.deepEqual((await getVideo(v.id, OWNER)).tags, ["Open house", "spring"]);
    const cleared = await updateVideo(v.id, videoPatchSchema.parse({ tags: [] }), OWNER);
    assert.equal(cleared.tags, undefined);
  });

  it("refuses too many or too long, with what is wrong", () => {
    assert.throws(() => videoPatchSchema.parse({ tags: Array.from({ length: 11 }, (_, i) => `tag ${i}`) }), /at most 10 tags/);
    assert.throws(() => videoPatchSchema.parse({ tags: ["x".repeat(25)] }), /at most 24 characters/);
    // Eleven spellings of fewer tags are fine: the limit counts tags once tidied.
    assert.deepEqual(videoPatchSchema.parse({ tags: Array.from({ length: 11 }, () => "Same") }).tags, ["Same"]);
  });

  it("are filtered by, case aside, searched, and counted in the library", async () => {
    const a = await createVideo(request("Kitchen"), OWNER);
    const b = await createVideo(request("Garden"), OWNER);
    await createVideo(request("Attic"), OWNER);
    await updateVideo(a.id, videoPatchSchema.parse({ tags: ["Spring", "Listing"] }), OWNER);
    await updateVideo(b.id, videoPatchSchema.parse({ tags: ["spring"] }), OWNER);
    const spring = await queryVideos(OWNER, videoQuerySchema.parse({ tag: "SPRING" }));
    assert.deepEqual(spring.videos.map((v) => v.title).sort(), ["Garden", "Kitchen"]);
    const searched = await queryVideos(OWNER, videoQuerySchema.parse({ q: "listing" }));
    assert.deepEqual(searched.videos.map((v) => v.title), ["Kitchen"]);
    // The counts are the view's, whatever the other filters (the two spellings are one tag; made in the same moment, either may name it).
    assert.deepEqual(spring.tags.map((t) => [t.name.toLowerCase(), t.count]), [["spring", 2], ["listing", 1]]);
  });

  it("keep tags set while a slower edit of the same video was under way, and the other way round", async () => {
    const v = await createVideo(request("Busy"), OWNER);
    // A password is hashed before it is written, so this edit read the video before the tag landed.
    const slow = updateVideo(v.id, videoPatchSchema.parse({ sharePassword: "open sesame" }), OWNER);
    await updateVideo(v.id, videoPatchSchema.parse({ tags: ["Spring"] }), OWNER);
    const after = await slow;
    assert.deepEqual([after.tags, after.shareLocked], [["Spring"], true]);
    const slowOff = updateVideo(v.id, videoPatchSchema.parse({ sharePassword: null }), OWNER);
    await updateVideo(v.id, videoPatchSchema.parse({ tags: [] }), OWNER);
    assert.equal((await slowOff).tags, undefined, "nor does it put back tags taken off meanwhile");
  });

  it("filter by a tag counted in characters, as tags are kept", () => {
    const emoji = "\u{1F3E1}".repeat(VIDEO_TAG_MAX);
    assert.equal(videoQuerySchema.parse({ tag: emoji }).tag, emoji, "an emoji tag at the limit is a tag one can filter by");
    assert.throws(() => videoQuerySchema.parse({ tag: "x".repeat(VIDEO_TAG_MAX + 1) }), /at most 24 characters/);
  });

  it("filter pure lists too, and a tag no video has matches none", () => {
    const videos = [made("a", { tags: ["Spring"] }), made("bb", { tags: ["Fall"] }), made("ccc")];
    assert.deepEqual(filterVideos(videos, videoQuerySchema.parse({ tag: "spring" })).map((v) => v.id), ["a"]);
    assert.deepEqual(filterVideos(videos, videoQuerySchema.parse({ tag: "winter" })), []);
  });
});

describe("tags on many videos at once", () => {
  const request = (title: string) => videoRequestSchema.parse({ title, avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Doors open Saturday." });

  it("adds and removes case aside, keeping each video's other tags in their order and spelling", () => {
    assert.deepEqual(retagged(["Spring", "Kitchen"], ["spring", "Listing"], []), ["Spring", "Kitchen", "Listing"]);
    assert.deepEqual(retagged(["Spring", "Kitchen"], [], ["SPRING"]), ["Kitchen"]);
    assert.deepEqual(retagged(undefined, ["Tour"], ["Tour"]), ["Tour"], "a tag both added and removed is added");
  });

  it("puts tags on and takes them off the selected videos, reporting those already full and those not there", async () => {
    const a = await createVideo(request("Kitchen"), OWNER);
    const b = await createVideo(request("Garden"), OWNER);
    const full = await createVideo(request("Full"), OWNER);
    await updateVideo(a.id, videoPatchSchema.parse({ tags: ["Kitchen"] }), OWNER);
    await updateVideo(full.id, videoPatchSchema.parse({ tags: Array.from({ length: VIDEO_TAGS_MAX }, (_, i) => `t${i}`) }), OWNER);
    const added = await bulkVideos(bulkVideoSchema.parse({ action: "tags", ids: [a.id, b.id, full.id, "nope"], add: [" Open  house", "spring"] }), OWNER);
    assert.deepEqual(added, { done: 2, missing: ["nope"], refused: [full.id] });
    assert.deepEqual((await getVideo(a.id, OWNER)).tags, ["Kitchen", "Open house", "spring"]);
    assert.deepEqual((await getVideo(b.id, OWNER)).tags, ["Open house", "spring"]);
    assert.equal((await getVideo(full.id, OWNER)).tags?.length, VIDEO_TAGS_MAX, "a full video is left as it was");
    // A tag a full video already has is no new tag, so it is fine.
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "tags", ids: [full.id], add: ["T0"] }), OWNER), { done: 1, missing: [], refused: [] });
    const removed = await bulkVideos(bulkVideoSchema.parse({ action: "tags", ids: [a.id, b.id], remove: ["SPRING", "open house"] }), OWNER);
    assert.equal(removed.done, 2);
    assert.deepEqual((await getVideo(a.id, OWNER)).tags, ["Kitchen"]);
    assert.equal((await getVideo(b.id, OWNER)).tags, undefined, "no key is kept for a video left with no tags");
  });

  it("leaves the rest of each video as stored: its approval, star, and counts, and others' videos alone", async () => {
    const v = await createVideo(request("Approved"), OWNER);
    await getStore().put("video", { ...(await getVideo(v.id, OWNER)), starred: true, views: 7, review: { status: "approved", requestedById: "u", requestedAt: "2026-11-01T00:00:00.000Z" } } as Video);
    const theirs = await createVideo(request("Theirs"), "someone_else");
    const result = await bulkVideos(bulkVideoSchema.parse({ action: "tags", ids: [v.id, theirs.id], add: ["Spring"] }), OWNER);
    assert.deepEqual(result, { done: 1, missing: [theirs.id], refused: [] });
    const after = await getVideo(v.id, OWNER);
    assert.deepEqual([after.tags, after.starred, after.views, after.review?.status], [["Spring"], true, 7, "approved"], "tags are not part of what the share page shows");
    assert.equal((await getVideo(theirs.id, "someone_else")).tags, undefined);
    // Nothing changed, nothing written.
    const before = (await getVideo(v.id, OWNER)).updatedAt;
    await bulkVideos(bulkVideoSchema.parse({ action: "tags", ids: [v.id], add: ["SPRING"], remove: ["Fall"] }), OWNER);
    assert.equal((await getVideo(v.id, OWNER)).updatedAt, before);
  });

  it("still takes tags off a video kept with more than the limit, and only refuses one an add would grow", async () => {
    const v = await createVideo(request("Old"), OWNER);
    const many = Array.from({ length: VIDEO_TAGS_MAX + 2 }, (_, i) => `old${i}`);
    await getStore().put("video", { ...(await getVideo(v.id, OWNER)), tags: many } as Video);
    assert.deepEqual(await bulkVideos(bulkVideoSchema.parse({ action: "tags", ids: [v.id], remove: ["old0"] }), OWNER), { done: 1, missing: [], refused: [] });
    assert.equal((await getVideo(v.id, OWNER)).tags?.length, VIDEO_TAGS_MAX + 1);
    assert.deepEqual((await bulkVideos(bulkVideoSchema.parse({ action: "tags", ids: [v.id], add: ["new"] }), OWNER)).refused, [v.id]);
  });

  it("refuses a request that names no tag, or one past the limits", () => {
    assert.equal(bulkVideoSchema.safeParse({ action: "tags", ids: ["a"] }).success, false);
    assert.equal(bulkVideoSchema.safeParse({ action: "tags", ids: ["a"], add: ["  "] }).success, false);
    assert.equal(bulkVideoSchema.safeParse({ action: "tags", ids: ["a"], add: ["x".repeat(VIDEO_TAG_MAX + 1)] }).success, false);
  });
});
