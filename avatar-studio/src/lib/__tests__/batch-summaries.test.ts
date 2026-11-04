// The Batch page's list of recent batches. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RECENT_BATCHES, batchSummaries } from "../services";
import type { Video } from "../types";

const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
const video = (id: string, extra: Partial<Video>): Video =>
  ({ id, title: id, script: "Hi", avatarId: "a", voiceId: "v", aspect: "16:9", status: "completed", provider: "mock", createdAt: at(0), updatedAt: at(0), ...extra }) as Video;

describe("recent batches", () => {
  it("counts one video per recipient, by where each is, with the title the batch was given", () => {
    const videos = [
      video("v1", { batchId: "batch_a", batchRow: 1, rowLabel: "Ana", title: "Welcome – Ana", status: "completed", createdAt: at(1) }),
      // Row 2 failed, then its retry is being made: the retry stands for the row.
      video("v2", { batchId: "batch_a", batchRow: 2, rowLabel: "Ben", title: "Welcome – Ben", status: "failed", createdAt: at(1) }),
      video("v2b", { batchId: "batch_a", batchRow: 2, rowLabel: "Ben", title: "Welcome – Ben", status: "processing", retryOf: "v2", createdAt: at(5) }),
      video("v3", { batchId: "batch_a", batchRow: 3, rowLabel: "Cy", title: "Welcome – Cy", status: "failed", createdAt: at(1) }),
      video("solo", { title: "Not in a batch", createdAt: at(9) }),
    ];
    assert.deepEqual(batchSummaries(videos), [{ batchId: "batch_a", title: "Welcome", videos: 3, ready: 1, making: 1, failed: 1, failedIds: ["v3"], startedAt: at(1) }]);
  });

  it("lists the newest batch first, at most the limit, and keeps a title it cannot trim", () => {
    const videos = [
      video("o1", { batchId: "batch_old", batchRow: 1, rowLabel: "Ana", title: "Old – Ana", createdAt: at(1) }),
      video("n1", { batchId: "batch_new", batchRow: 1, rowLabel: "Ana", title: "Renamed by hand", createdAt: at(2) }),
    ];
    const list = batchSummaries(videos);
    assert.deepEqual(list.map((b) => [b.batchId, b.title]), [
      ["batch_new", "Renamed by hand"],
      ["batch_old", "Old"],
    ]);
    assert.deepEqual(batchSummaries(videos, 1).map((b) => b.batchId), ["batch_new"]);
    assert.equal(RECENT_BATCHES, 20);
  });

  it("takes the title from a recipient whose video still carries it, and counts a queued render as being made", () => {
    const videos = [
      // Row 1 was cut short at 120 characters, so its recipient is not at the end; row 2 still carries it.
      video("r1", { batchId: "batch_c", batchRow: 1, rowLabel: "Alexandra", title: `${"T".repeat(110)} – Alexa`, status: "queued", createdAt: at(1) }),
      video("r2", { batchId: "batch_c", batchRow: 2, rowLabel: "Bo", title: "Long title – Bo", status: "completed", createdAt: at(1) }),
    ];
    assert.deepEqual(batchSummaries(videos)[0], { batchId: "batch_c", title: "Long title", videos: 2, ready: 1, making: 1, failed: 0, failedIds: [], startedAt: at(1) });
    // A retry standing for row 1 gives the title, and the earliest render gives the start.
    const retried = [
      video("f1", { batchId: "batch_d", batchRow: 1, rowLabel: "Ana", title: "Hello – Ana", status: "failed", createdAt: at(1) }),
      video("f1b", { batchId: "batch_d", batchRow: 1, rowLabel: "Ana", title: "Hello – Ana", status: "completed", retryOf: "f1", createdAt: at(4) }),
    ];
    assert.deepEqual(batchSummaries(retried)[0], { batchId: "batch_d", title: "Hello", videos: 1, ready: 1, making: 0, failed: 0, failedIds: [], startedAt: at(1) });
  });

  it("names the failed renders to start again: a retry that failed too, not the render it replaced, in the CSV's order", () => {
    const videos = [
      video("b3", { batchId: "batch_e", batchRow: 3, rowLabel: "Cy", title: "Hi – Cy", status: "failed", createdAt: at(1) }),
      video("b1", { batchId: "batch_e", batchRow: 1, rowLabel: "Ana", title: "Hi – Ana", status: "failed", createdAt: at(1) }),
      video("b1b", { batchId: "batch_e", batchRow: 1, rowLabel: "Ana", title: "Hi – Ana", status: "failed", retryOf: "b1", createdAt: at(1) }),
      video("b2", { batchId: "batch_e", batchRow: 2, rowLabel: "Bo", title: "Hi – Bo", status: "completed", createdAt: at(1) }),
    ];
    const [summary] = batchSummaries(videos);
    assert.equal(summary.failed, 2);
    assert.deepEqual(summary.failedIds, ["b1b", "b3"]);
    // A failed render whose retry is still being made is not offered again, so a second click does not pay twice.
    const making = [
      video("m1", { batchId: "batch_f", batchRow: 1, rowLabel: "Ana", title: "Hi – Ana", status: "failed", createdAt: at(1) }),
      video("m1b", { batchId: "batch_f", batchRow: 1, rowLabel: "Ana", title: "Hi – Ana", status: "queued", retryOf: "m1", createdAt: at(1) }),
    ];
    assert.deepEqual(batchSummaries(making)[0], { batchId: "batch_f", title: "Hi", videos: 1, ready: 0, making: 1, failed: 0, failedIds: [], startedAt: at(1) });
  });

  it("has nothing to list without batches", () => {
    assert.deepEqual(batchSummaries([]), []);
    assert.deepEqual(batchSummaries([video("solo", {})]), []);
  });
});
