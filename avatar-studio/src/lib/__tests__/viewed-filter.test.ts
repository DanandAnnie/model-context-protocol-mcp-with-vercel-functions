// The library filtered by views: finished videos whose share page has been viewed, or not yet. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { VIEWED_FILTERS, inViewed, withoutLibraryFilters } from "../client";
import { filterVideos, queryVideos, videoQuerySchema } from "../services";
import type { Video } from "../types";

const made = (id: string, views: number | undefined, patch: Partial<Video> = {}) =>
  ({ id, title: id, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", aspect: "16:9", views, createdAt: new Date(Date.now() - Number(id.replace(/\D/g, "") || 0) * 1000).toISOString(), updatedAt: new Date().toISOString(), ...patch }) as Video;

describe("views filter", () => {
  const videos = [
    made("seen1", 3),
    made("never2", undefined),
    made("zero3", 0),
    made("seen4", 1, { batchId: "batch_v" }),
    made("never5", undefined, { batchId: "batch_v" }),
    made("rendering6", undefined, { status: "processing", batchId: "batch_v" }),
    made("failed7", undefined, { status: "failed", batchId: "batch_v" }),
  ];
  const ids = (q: Record<string, string>) => filterVideos(videos, videoQuerySchema.parse(q)).map((v) => v.id);

  it("keeps the viewed videos, or the finished ones not viewed yet, and leaves unfinished renders out of both", () => {
    assert.deepEqual(ids({ viewed: "yes" }), ["seen1", "seen4"]);
    assert.deepEqual(ids({ viewed: "no" }), ["never2", "zero3", "never5"]);
    assert.equal(ids({}).length, 7, "absent means any, the unfinished renders included");
    assert.equal(ids({ viewed: "all" }).length, 7);
    assert.deepEqual(VIEWED_FILTERS, ["yes", "no"]);
    assert.equal(inViewed({ status: "processing", views: 2 }, "yes"), false, "a render in flight is in neither");
    assert.equal(inViewed({ status: "failed" }, "no"), false);
    assert.equal(inViewed({ views: 2 }, "yes"), false, "no status, not finished");
  });

  it("lists a batch's recipients still to follow up, and combines with the other filters and the sort", () => {
    assert.deepEqual(ids({ viewed: "no", batch: "batch_v" }), ["never5"]);
    assert.deepEqual(ids({ viewed: "yes", sort: "views" }), ["seen1", "seen4"]);
    assert.deepEqual(ids({ viewed: "no", q: "zero" }), ["zero3"]);
    assert.deepEqual(ids({ viewed: "no", status: "processing" }), []);
    assert.equal(videoQuerySchema.safeParse({ viewed: "true" }).success, false);
    assert.equal(videoQuerySchema.safeParse({ viewed: "0" }).success, false);
  });

  it("filters the trash by views too, and Clear filters takes it off the address", async () => {
    globalThis.__avatarStudioStore = new MemoryStore();
    const owner = "user_viewed_trash";
    for (const v of [made("t1", 2), made("t2", undefined), made("t3", 0)]) await getStore().put("video", { ...v, ownerId: owner, deletedAt: new Date().toISOString() });
    const page = await queryVideos(owner, videoQuerySchema.parse({ trash: "true", viewed: "no" }));
    assert.deepEqual(page.videos.map((v) => v.id).sort(), ["t2", "t3"]);
    assert.equal(page.trashed, 3, "the toggle still counts the whole trash");
    assert.equal(withoutLibraryFilters("batch=batch_v&viewed=no&ref=home"), "?ref=home");
  });

  it("counts the renders in flight that Not viewed yet leaves out, with a length filter too, but not for Viewed", async () => {
    globalThis.__avatarStudioStore = new MemoryStore();
    const owner = "user_viewed_pending";
    // Renders in flight the demo renderer has only just started (its job id carries the start time), so they stay in flight.
    const running = (id: string) => made(id, undefined, { status: "processing", providerJobId: `mock_${Date.now()}_5` });
    for (const v of [made("d1", undefined, { durationSec: 30 }), made("d2", 4, { durationSec: 30 }), running("p3"), running("p4")]) await getStore().put("video", { ...v, ownerId: owner });
    const ask = async (q: Record<string, string>) => queryVideos(owner, videoQuerySchema.parse(q));
    const unviewed = await ask({ viewed: "no" });
    assert.deepEqual(unviewed.videos.map((v) => v.id), ["d1"]);
    assert.equal(unviewed.lengthPending, 2, "a finished render joins Not viewed yet, so it waits");
    assert.equal((await ask({ viewed: "no", length: "short" })).lengthPending, 2, "both filters together still count them");
    assert.equal((await ask({ viewed: "yes" })).lengthPending, 0, "a finished render has no views, so Viewed waits on none");
    assert.equal((await ask({ viewed: "yes", length: "short" })).lengthPending, 0);
    assert.equal((await ask({ length: "short" })).lengthPending, 2, "the length filter alone, as before");
    assert.equal((await ask({})).lengthPending, 0);
  });
});
