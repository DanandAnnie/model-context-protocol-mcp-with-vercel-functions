import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RETENTION_POINTS, biggestDrop, retentionCounts, retentionPoint, retentionShares } from "../retention";

describe("retention", () => {
  it("names the furthest tenth a playhead has reached, the end only at the end", () => {
    assert.equal(retentionPoint(0, 60), 0);
    assert.equal(retentionPoint(5.9, 60), 0);
    assert.equal(retentionPoint(6, 60), 1);
    assert.equal(retentionPoint(30, 60), 5);
    assert.equal(retentionPoint(59.9, 60), 9, "the last tenth is 9 until the end");
    assert.equal(retentionPoint(60, 60), 9);
    assert.equal(retentionPoint(60, 60, { ended: true }), 10);
    assert.equal(retentionPoint(59.8, 60, { nearEnd: true }), 10, "a looping video's last moment counts as the end");
    assert.equal(retentionPoint(3, 0), 0, "no length yet");
    assert.equal(retentionPoint(3, Number.NaN), 0);
    assert.equal(retentionPoint(1.2, 12), 1, "a whole tenth despite floating point");
  });

  it("reads stored counts whole, whatever is stored", () => {
    assert.deepEqual(retentionCounts(undefined), Array(RETENTION_POINTS).fill(0));
    assert.deepEqual(retentionCounts([3, 2.7, -1, Number.NaN]).slice(0, 5), [3, 2, 0, 0, 0]);
    assert.equal(retentionCounts(Array(20).fill(1)).length, RETENTION_POINTS);
  });

  it("gives each tenth's share of the viewers who started, never rising", () => {
    assert.equal(retentionShares(undefined), null);
    assert.equal(retentionShares([0, 0, 0]), null, "nobody started");
    const r = retentionShares([10, 10, 9, 8, 8, 6, 5, 5, 4, 3, 2])!;
    assert.equal(r.started, 10);
    assert.deepEqual(r.shares, [100, 90, 80, 80, 60, 50, 50, 40, 30, 20]);
    // A count above the starts (counted before starting was), or a later point above an earlier one, is capped.
    assert.deepEqual(retentionShares([4, 6, 2, 3, 0, 0, 0, 0, 0, 0, 0])!.shares, [100, 50, 50, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(retentionShares([3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1])!.shares, [67, 67, 67, 33, 33, 33, 33, 33, 33, 33]);
  });

  it("finds where most viewers left", () => {
    assert.deepEqual(biggestDrop([100, 90, 80, 80, 60, 50, 50, 40, 30, 20]), { from: 4, to: 5, points: 20 });
    assert.deepEqual(biggestDrop([50, 50, 50, 50, 50, 50, 50, 50, 50, 50]), { from: 0, to: 1, points: 50 }, "from the start");
    assert.equal(biggestDrop(Array(10).fill(100)), null, "nobody left");
    assert.deepEqual(biggestDrop([90, 80, 70, 60, 50, 40, 30, 20, 10, 0]), { from: 0, to: 1, points: 10 }, "the first of equal falls");
  });
});
