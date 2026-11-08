// Share views by where they play: the share page itself or an embed of its player.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { createVideo, getVideo, recordView, updateVideo, videoPatchSchema, videoRequestSchema, viewSchema } from "../services";
import { analyticsRows } from "../insights";
import { STOCK_AVATARS, STOCK_VOICES } from "../stock";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

async function completedVideo() {
  const v = await createVideo(
    videoRequestSchema.parse({ title: "Maple Street", avatarId: STOCK_AVATARS[0].id, voiceId: STOCK_VOICES[0].id, script: "Welcome to twelve Maple Street." }),
  );
  const stored = await getVideo(v.id, undefined, false);
  globalThis.__avatarStudioStore!.put("video", { ...stored, status: "completed" });
  return v.id;
}

describe("recordView by place", () => {
  it("counts every view, and the embedded ones apart", async () => {
    const id = await completedVideo();
    assert.deepEqual(await recordView(id, () => true, undefined, "page"), { views: 1, counted: true });
    assert.deepEqual(await recordView(id, () => true, undefined, "embed"), { views: 2, counted: true });
    assert.deepEqual(await recordView(id, () => true, undefined, "embed"), { views: 3, counted: true });
    assert.equal((await recordView(id)).views, 4, "no place is the share page");
    const video = await getVideo(id, undefined, false);
    assert.equal(video.views, 4);
    assert.equal(video.embedViews, 2);
  });

  it("counts nothing for a repeat inside the viewer's window, embedded or not", async () => {
    const id = await completedVideo();
    assert.deepEqual(await recordView(id, () => false, undefined, "embed"), { views: 0, counted: false });
    assert.equal((await getVideo(id, undefined, false)).embedViews, undefined);
  });

  it("keeps the embedded count through an owner's edit made from an earlier read", async () => {
    const id = await completedVideo();
    await recordView(id, () => true, undefined, "embed");
    const [edited] = await Promise.all([updateVideo(id, videoPatchSchema.parse({ title: "Renamed" })), recordView(id, () => true, undefined, "embed")]);
    assert.equal(edited.title, "Renamed");
    const video = await getVideo(id, undefined, false);
    assert.equal(video.embedViews, 2);
    assert.equal(video.views, 2);
  });

  it("goes in the analytics file", async () => {
    const id = await completedVideo();
    await recordView(id, () => true, undefined, "embed");
    const [row] = analyticsRows([await getVideo(id, undefined, false)], "https://studio.example.com");
    assert.equal(row.embed_views, 1);
    assert.equal(row.views, 1);
  });
});

describe("viewSchema", () => {
  it("takes a place, or none", () => {
    assert.deepEqual(viewSchema.parse({}), {});
    assert.deepEqual(viewSchema.parse({ place: "embed" }), { place: "embed" });
    assert.deepEqual(viewSchema.parse({ place: "page" }), { place: "page" });
    assert.throws(() => viewSchema.parse({ place: "email" }));
    assert.deepEqual(viewSchema.parse({ place: "embed", views: 100 }), { place: "embed" }, "nothing else rides along");
  });
});
