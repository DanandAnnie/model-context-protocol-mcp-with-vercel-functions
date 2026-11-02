// Home's notice of failed renders counts what the library's Failed and "Made in the last 7 days" filters list.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allowanceNotice, awaitingReview, failedThisWeek, madeWithin } from "../client";
import { filterVideos, videoQuerySchema } from "../services";
import type { Video } from "../types";

describe("failed renders on Home", () => {
  it("counts this week's failed renders as the library's filters list them", () => {
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const videos = [
      { id: "v0", status: "failed", createdAt: ago(0) },
      { id: "v1", status: "failed", createdAt: ago(6.9) },
      { id: "v2", status: "failed", createdAt: ago(7.1) },
      { id: "v3", status: "failed", createdAt: "not a time" },
      { id: "v4", status: "completed", createdAt: ago(1) },
      { id: "v5", status: "processing", createdAt: ago(1) },
      { id: "v6", status: "failed", createdAt: ago(2) },
      { id: "v7", status: "completed", createdAt: ago(1), retryOf: "v6" },
    ];
    assert.equal(failedThisWeek(videos, now), 2, "older than a week, unreadable, not failed, and retried are left out");
    assert.equal(failedThisWeek([], now), 0);
    // The library's filters list the same two, with the retried one beside them.
    const stored = videos.map((v) => ({ title: v.id, script: "", ...v }) as unknown as Video);
    assert.deepEqual(filterVideos(stored, videoQuerySchema.parse({ status: "failed", created: "7d" })).map((v) => v.id).sort(), ["v0", "v1", "v6"]);
  });

  it("puts a video in a window from its creation time, and an unreadable one in none", () => {
    const now = Date.parse("2030-06-08T12:00:00Z");
    assert.equal(madeWithin({ createdAt: "2030-06-01T12:00:00Z" }, "7d", now), true, "exactly seven days ago");
    assert.equal(madeWithin({ createdAt: "2030-06-01T11:59:59Z" }, "7d", now), false);
    assert.equal(madeWithin({ createdAt: "2030-05-10T12:00:00Z" }, "30d", now), true);
    assert.equal(madeWithin({ createdAt: "2030-03-01T12:00:00Z" }, "90d", now), false);
    assert.equal(madeWithin({ createdAt: "" }, "90d", now), false);
  });

  it("counts the videos in review as the library's review filter lists them", () => {
    const videos = [
      { id: "a", review: { status: "pending" } },
      { id: "b", review: { status: "pending" } },
      { id: "c", review: { status: "approved" } },
      { id: "d", review: { status: "changes" } },
      { id: "e" },
    ];
    assert.equal(awaitingReview(videos), 2);
    assert.equal(awaitingReview([]), 0);
    const stored = videos.map((v) => ({ title: v.id, script: "", status: "completed", createdAt: new Date().toISOString(), ...v }) as unknown as Video);
    assert.deepEqual(filterVideos(stored, videoQuerySchema.parse({ review: "pending" })).map((v) => v.id).sort(), ["a", "b"]);
  });

  it("speaks of the render allowance once a fifth of it or less is left, with when it starts again", () => {
    const now = Date.parse("2030-06-14T23:30:00Z");
    assert.equal(allowanceNotice(5, null, now), undefined, "no allowance");
    assert.equal(allowanceNotice(5, 0, now), undefined, "no allowance");
    assert.equal(allowanceNotice(15, 20, now), undefined, "five of twenty left is more than a fifth");
    assert.deepEqual(allowanceNotice(16, 20, now), { left: 4, used: 16, limit: 20, resetsAt: "2030-07-01T00:00:00.000Z" });
    assert.deepEqual(allowanceNotice(25, 20, now), { left: 0, used: 25, limit: 20, resetsAt: "2030-07-01T00:00:00.000Z" }, "over the allowance (a plan moved down mid-month) reads as used up, with the real count");
    assert.equal(allowanceNotice(1, 3, now), undefined, "a small allowance: two of three left");
    assert.deepEqual(allowanceNotice(2, 3, now)?.left, 1, "the last render is always pointed out");
    assert.equal(allowanceNotice(0, 3, now), undefined);
    assert.equal(allowanceNotice(9, 10, Date.parse("2030-12-31T23:59:59Z"))?.resetsAt, "2031-01-01T00:00:00.000Z", "December runs into January");
  });
});
