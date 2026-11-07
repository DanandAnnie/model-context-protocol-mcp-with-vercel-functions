// The library filtered by when videos were made: the last 7, 30, or 90 days, with the other filters. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { getStore } from "../store";
import { filterVideos, queryVideos, videoQuerySchema } from "../services";
import type { Video } from "../types";

const day = 86_400_000;
const made = (id: string, daysAgo: number, patch: Partial<Video> = {}) =>
  ({ id, title: id, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", createdAt: new Date(Date.now() - daysAgo * day).toISOString(), updatedAt: new Date().toISOString(), ...patch }) as Video;

describe("created filter", () => {
  const videos = [made("today", 0), made("six", 6.9), made("eight", 8), made("month", 29.5), made("quarter", 89), made("old", 120)];
  const ids = (q: Record<string, string>) => filterVideos(videos, videoQuerySchema.parse(q)).map((v) => v.id);

  it("keeps the videos made within the window, newest first", () => {
    assert.deepEqual(ids({ created: "7d" }), ["today", "six"]);
    assert.deepEqual(ids({ created: "30d" }), ["today", "six", "eight", "month"]);
    assert.deepEqual(ids({ created: "90d" }), ["today", "six", "eight", "month", "quarter"]);
    assert.equal(ids({}).length, 6, "absent means any time");
    assert.equal(ids({ created: "all" }).length, 6);
  });

  it("combines with the other filters and refuses an unknown window", () => {
    const more = [...videos, made("failed-recent", 2, { status: "failed" }), made("starred-old", 40, { starred: true }), made("starred-new", 1, { starred: true })];
    const pick = (q: Record<string, string>) => filterVideos(more, videoQuerySchema.parse(q)).map((v) => v.id);
    assert.deepEqual(pick({ created: "7d", status: "failed" }), ["failed-recent"]);
    assert.deepEqual(pick({ created: "30d", starred: "1" }), ["starred-new"]);
    assert.deepEqual(pick({ created: "7d", sort: "oldest" }), ["six", "failed-recent", "starred-new", "today"]);
    assert.equal(videoQuerySchema.safeParse({ created: "1y" }).success, false);
  });

  it("leaves a video whose creation time cannot be read out of every window", () => {
    const odd = [made("unreadable", 0, { createdAt: "" }), made("fine", 1)];
    assert.deepEqual(filterVideos(odd, videoQuerySchema.parse({ created: "7d" })).map((v) => v.id), ["fine"]);
    assert.equal(filterVideos(odd, videoQuerySchema.parse({})).length, 2);
  });

  it("filters the trash by when the videos were made, newest deletion first", async () => {
    globalThis.__avatarStudioStore = new MemoryStore();
    const owner = "user_created_trash";
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
    for (const [id, madeAgo, deletedAgo] of [["recent-early", 2, 1.5], ["recent-late", 3, 0.5], ["old", 60, 1]] as const) {
      await getStore().put("video", { ...made(id, madeAgo), ownerId: owner, deletedAt: at(deletedAgo) });
    }
    const page = await queryVideos(owner, videoQuerySchema.parse({ trash: "true", created: "7d" }));
    assert.deepEqual(page.videos.map((v) => v.id), ["recent-late", "recent-early"]);
    assert.equal(page.trashed, 3, "the toggle still counts the trash");
  });
});
