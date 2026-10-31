import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasNewVisits, markVisitsSeen, mergeSeenVisits, parseSeenVisits, seedSeenVisits } from "../seen-visits";

const t = (n: number) => `2026-10-31T10:00:0${n}.000Z`;

describe("new visits mark", () => {
  it("counts what each workspace had when first listed as seen, and marks what comes later", () => {
    const personal = [{ id: "p1", ownerId: "me", lastVisitAt: t(2) }, { id: "p2", ownerId: "me" }];
    let record = seedSeenVisits(parseSeenVisits(null), personal)!;
    assert.deepEqual(record.since, { me: t(2) });
    assert.equal(seedSeenVisits(record, personal), null, "an owner is seeded once");
    assert.ok(!hasNewVisits(record, personal[0]));
    assert.ok(hasNewVisits(record, { ...personal[1], lastVisitAt: t(3) }), "a presenter never opened is compared to its owner's start");
    // Another workspace, listed later in the same browser, starts its own count and leaves the first one's alone.
    const team = [{ id: "w1", ownerId: "team", lastVisitAt: t(1) }];
    record = seedSeenVisits(record, team)!;
    assert.deepEqual(record.since, { me: t(2), team: t(1) });
    assert.ok(!hasNewVisits(record, team[0]));
    record = markVisitsSeen(record, "w1", t(5));
    assert.ok(!hasNewVisits(record, personal[0]), "opening a team presenter keeps the personal ones as they were");
    assert.ok(hasNewVisits(record, { ...personal[0], lastVisitAt: t(6) }));
  });

  it("merges what two tabs wrote: an owner's first start stands and a presenter keeps its later seen time", () => {
    const stored = { since: { team: t(1) }, seen: { w1: t(4), p1: t(2) } };
    const mine = { since: { me: t(2), team: t(3) }, seen: { p1: t(5), w1: t(3) } };
    assert.deepEqual(mergeSeenVisits(stored, mine), { since: { me: t(2), team: t(1) }, seen: { w1: t(4), p1: t(5) } });
  });

  it("never moves a presenter's seen time back, and reads only a well-formed record", () => {
    const record = markVisitsSeen({ since: {}, seen: {} }, "p1", t(4));
    assert.equal(markVisitsSeen(record, "p1", t(3)), record);
    assert.equal(markVisitsSeen(record, "p1", t(5)).seen.p1, t(5));
    assert.deepEqual(parseSeenVisits(JSON.stringify(record)), record);
    assert.deepEqual(parseSeenVisits("{not json"), { since: {}, seen: {} });
    assert.deepEqual(parseSeenVisits(JSON.stringify({ since: { a: 1, b: t(1) }, seen: [t(2)] })), { since: { b: t(1) }, seen: {} });
    assert.ok(!hasNewVisits({ since: {}, seen: {} }, { id: "x", ownerId: "unseeded", lastVisitAt: t(1) }), "an owner not yet listed marks nothing");
  });
});
