// Undo and redo for the editor's scene changes.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_HISTORY, emptyHistory, record, redo, undo } from "../scene-history";

describe("scene history", () => {
  it("undoes and redoes a change, in order", () => {
    const a = ["a"];
    const b = ["a", "b"];
    const c = ["a", "b", "c"];
    let h = record(emptyHistory<string[]>(), { label: "add scene 2", before: a, after: b });
    h = record(h, { label: "add scene 3", before: b, after: c });
    const u1 = undo(h, c)!;
    assert.equal(u1.state, b);
    assert.equal(u1.entry.label, "add scene 3");
    assert.equal(u1.changedSince, false);
    const u2 = undo(u1.history, b)!;
    assert.equal(u2.state, a);
    assert.equal(undo(u2.history, a), null);
    const r1 = redo(u2.history, a)!;
    assert.equal(r1.state, b);
    assert.equal(r1.entry.label, "add scene 2");
    assert.equal(redo(r1.history, b)!.state, c);
  });

  it("says when the state has changed since, so undoing would take that back too", () => {
    const a = ["a"];
    const b = ["a", "b"];
    const h = record(emptyHistory<string[]>(), { label: "add scene 2", before: a, after: b });
    const typed = ["a", "b typed"];
    assert.equal(undo(h, typed)!.changedSince, true);
    const u = undo(h, b)!;
    assert.equal(redo(u.history, ["a typed"])!.changedSince, true);
  });

  it("keeps what an undo over later edits takes back, so redoing brings the edits back", () => {
    const a = ["one"];
    const b = ["one", ""];
    const typed = ["one", "two"];
    const h = record(emptyHistory<string[]>(), { label: "add scene 2", before: a, after: b });
    const u = undo(h, typed)!;
    assert.equal(u.changedSince, true);
    assert.equal(u.state, a);
    const r = redo(u.history, a)!;
    assert.equal(r.changedSince, false);
    assert.equal(r.state, typed);
    // And the other way: what a redo replaces comes back with an undo.
    const edited = ["one edited"];
    const r2 = redo(u.history, edited)!;
    assert.equal(r2.changedSince, true);
    assert.equal(undo(r2.history, r2.state)!.state, edited);
  });

  it("compares states as the caller says", () => {
    const h = record(emptyHistory<{ n: number }>(), { label: "x", before: { n: 1 }, after: { n: 2 } });
    assert.equal(undo(h, { n: 2 })!.changedSince, true);
    assert.equal(undo(h, { n: 2 }, (x, y) => x.n === y.n)!.changedSince, false);
  });

  it("forgets what was undone once something new is done, and keeps only the last changes", () => {
    let h = record(emptyHistory<number>(), { label: "one", before: 0, after: 1 });
    h = undo(h, 1)!.history;
    h = record(h, { label: "two", before: 0, after: 2 });
    assert.equal(redo(h, 2), null);
    for (let i = 0; i < MAX_HISTORY + 5; i++) h = record(h, { label: `n${i}`, before: i, after: i + 1 });
    assert.equal(h.past.length, MAX_HISTORY);
    assert.equal(h.past[0].label, "n5");
  });
});
