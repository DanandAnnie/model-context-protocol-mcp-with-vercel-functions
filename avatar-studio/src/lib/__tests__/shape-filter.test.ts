// The library filtered by shape: landscape 16:9, portrait 9:16, square 1:1, with the other filters. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { SHAPE_FILTERS, inShape, withoutLibraryFilters } from "../client";
import { filterVideos, queryVideos, videoQuerySchema } from "../services";
import type { Video } from "../types";

const made = (id: string, aspect: Video["aspect"] | undefined, patch: Partial<Video> = {}) =>
  ({ id, title: id, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", aspect, createdAt: new Date(Date.now() - Number(id.replace(/\D/g, "") || 0) * 1000).toISOString(), updatedAt: new Date().toISOString(), ...patch }) as Video;

describe("shape filter", () => {
  const videos = [made("wide1", "16:9"), made("tall2", "9:16"), made("box3", "1:1"), made("tall4", "9:16"), made("old5", undefined)];
  const ids = (q: Record<string, string>) => filterVideos(videos, videoQuerySchema.parse(q)).map((v) => v.id);

  it("keeps the videos made in the shape asked for; one with no aspect stored is the 16:9 default", () => {
    assert.deepEqual(ids({ shape: "portrait" }), ["tall2", "tall4"]);
    assert.deepEqual(ids({ shape: "square" }), ["box3"]);
    assert.deepEqual(ids({ shape: "landscape" }), ["wide1", "old5"]);
    assert.equal(ids({}).length, 5, "absent means any shape");
    assert.equal(ids({ shape: "all" }).length, 5);
    assert.deepEqual(SHAPE_FILTERS, ["landscape", "portrait", "square"]);
    assert.equal(inShape({}, "landscape"), true);
    assert.equal(inShape({ aspect: "9:16" }, "landscape"), false);
  });

  it("combines with the other filters and the sort, and refuses an unknown shape", () => {
    const more = [...videos, made("tall6", "9:16", { status: "failed" }), made("tall7", "9:16", { starred: true })];
    const pick = (q: Record<string, string>) => filterVideos(more, videoQuerySchema.parse(q)).map((v) => v.id);
    assert.deepEqual(pick({ shape: "portrait", status: "failed" }), ["tall6"]);
    assert.deepEqual(pick({ shape: "portrait", starred: "1" }), ["tall7"]);
    assert.deepEqual(pick({ shape: "portrait", sort: "oldest" }), ["tall7", "tall6", "tall4", "tall2"]);
    assert.deepEqual(pick({ shape: "portrait", q: "tall2" }), ["tall2"]);
    assert.equal(videoQuerySchema.safeParse({ shape: "9:16" }).success, false);
    assert.equal(videoQuerySchema.safeParse({ shape: "round" }).success, false);
  });

  it("filters the trash by shape too, and Clear filters takes it off the address", async () => {
    globalThis.__avatarStudioStore = new MemoryStore();
    const owner = "user_shape_trash";
    for (const v of [made("t1", "9:16"), made("t2", "16:9"), made("t3", "9:16")]) await getStore().put("video", { ...v, ownerId: owner, deletedAt: new Date().toISOString() });
    const page = await queryVideos(owner, videoQuerySchema.parse({ trash: "true", shape: "portrait" }));
    assert.deepEqual(page.videos.map((v) => v.id).sort(), ["t1", "t3"]);
    assert.equal(page.trashed, 3, "the toggle still counts the whole trash");
    assert.equal(withoutLibraryFilters("shape=portrait&ref=home"), "?ref=home");
  });
});
