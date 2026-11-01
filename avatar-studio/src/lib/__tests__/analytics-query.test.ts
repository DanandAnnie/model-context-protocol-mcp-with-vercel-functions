// The analytics CSV holds what the library shows: its filters and its order, each video once. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANALYTICS_COLUMNS, analyticsRows } from "../insights";
import { filterVideos, videoQuerySchema } from "../services";
import { parseCsv, toCsv } from "../csv";
import type { Video } from "../types";

const made = (id: string, daysAgo: number, patch: Partial<Video> = {}) =>
  ({ id, title: `Tour ${id}`, script: "Hi.", avatarId: "a", voiceId: "v", status: "completed", provider: "mock", createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), updatedAt: new Date().toISOString(), ...patch }) as Video;

describe("analytics for the library's query", () => {
  const videos = [made("a", 1, { starred: true, views: 3 }), made("b", 2, { views: 9 }), made("c", 40, { starred: true, views: 5 }), made("d", 3, { status: "failed" })];
  const ids = (q: Record<string, string>) => {
    const csv = parseCsv(toCsv([...ANALYTICS_COLUMNS], analyticsRows(filterVideos(videos, videoQuerySchema.parse(q)), "https://s")));
    return csv.rows.map((r) => r.id);
  };

  it("holds every video, newest first, with no query", () => {
    assert.deepEqual(ids({}), ["a", "b", "d", "c"]);
  });

  it("holds only what the filters keep, in the sort asked for", () => {
    assert.deepEqual(ids({ starred: "1" }), ["a", "c"]);
    assert.deepEqual(ids({ starred: "1", created: "30d" }), ["a"]);
    assert.deepEqual(ids({ sort: "views" }), ["b", "c", "a", "d"]);
    assert.deepEqual(ids({ status: "failed" }), ["d"]);
    assert.deepEqual(ids({ q: "tour c" }), ["c"]);
  });

  it("ignores the library's page size, so the file holds every match", () => {
    assert.equal(ids({ limit: "1" }).length, 4);
  });
});
