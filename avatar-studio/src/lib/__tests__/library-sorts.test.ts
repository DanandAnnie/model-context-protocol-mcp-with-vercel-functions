// The library's sorts by latest view and by length: videos without one come last, newest first among ties.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { filterVideos, queryVideos, videoQuerySchema } from "../services";
import type { Video } from "../types";

const made = (id: string, createdAt: string, patch: Partial<Video> = {}) =>
  ({ id, title: id, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", createdAt, updatedAt: createdAt, ...patch }) as Video;

describe("library sorts", () => {
  const videos = [
    made("seen-yesterday", "2026-10-01T00:00:00Z", { lastViewedAt: "2026-10-31T12:00:00Z", durationSec: 30 }),
    made("seen-today", "2026-09-01T00:00:00Z", { lastViewedAt: "2026-11-01T09:00:00Z", durationSec: 95 }),
    made("never-new", "2026-10-20T00:00:00Z", { durationSec: 95 }),
    made("never-old", "2026-08-01T00:00:00Z"),
    made("rendering", "2026-10-25T00:00:00Z", { status: "processing", lastViewedAt: "bad date" }),
  ];
  const order = (sort: string) => filterVideos(videos, videoQuerySchema.parse({ sort })).map((v) => v.id);

  it("puts the latest view first, then the never-viewed newest first", () => {
    assert.deepEqual(order("viewed"), ["seen-today", "seen-yesterday", "rendering", "never-new", "never-old"]);
  });

  it("puts the longest first, ties newest first, and untimed renders last", () => {
    assert.deepEqual(order("length"), ["never-new", "seen-today", "seen-yesterday", "rendering", "never-old"]);
  });

  it("sorts the trash by these too, rather than by deletion time", async () => {
    globalThis.__avatarStudioStore = new MemoryStore();
    const owner = "user_sorts_trash";
    const deletedAt = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    await getStore().put("video", { ...made("short-deleted-last", "2026-10-01T00:00:00Z", { durationSec: 10 }), ownerId: owner, deletedAt: deletedAt(1) });
    await getStore().put("video", { ...made("long-deleted-first", "2026-10-02T00:00:00Z", { durationSec: 90 }), ownerId: owner, deletedAt: deletedAt(5) });
    const page = await queryVideos(owner, videoQuerySchema.parse({ trash: "true", sort: "length" }));
    assert.deepEqual(page.videos.map((v) => v.id), ["long-deleted-first", "short-deleted-last"]);
  });

  it("refuses an unknown sort", () => {
    assert.equal(videoQuerySchema.safeParse({ sort: "random" }).success, false);
  });
});
