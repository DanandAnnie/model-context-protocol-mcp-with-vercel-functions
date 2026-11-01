// While selecting in the library, a plain click turns one video on or off and Shift+click sets a run of them, from the
// one clicked last, as that one now is.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clickSelect } from "../client";
import { shortcutGroups } from "../shortcuts";

const order = ["a", "b", "c", "d", "e", "f"];
const sorted = (s: Set<string>) => [...s].sort();

describe("clickSelect", () => {
  it("toggles one video on a plain click and makes it the one clicked last", () => {
    const on = clickSelect(new Set(), order, null, "b", false);
    assert.deepEqual(sorted(on.selected), ["b"]);
    assert.equal(on.anchor, "b");
    const off = clickSelect(on.selected, order, on.anchor, "b", false);
    assert.deepEqual(sorted(off.selected), []);
    assert.equal(off.anchor, "b");
  });

  it("selects the run from the one clicked last, in either direction, keeping what was selected", () => {
    const first = clickSelect(new Set(["f"]), order, null, "b", false);
    const down = clickSelect(first.selected, order, first.anchor, "d", true);
    assert.deepEqual(sorted(down.selected), ["b", "c", "d", "f"]);
    assert.equal(down.anchor, "d");
    const up = clickSelect(new Set(["e"]), order, "e", "c", true);
    assert.deepEqual(sorted(up.selected), ["c", "d", "e"]);
  });

  it("unselects the run when the one clicked last was just unselected", () => {
    const off = clickSelect(new Set(order), order, null, "b", false);
    const run = clickSelect(off.selected, order, off.anchor, "e", true);
    assert.deepEqual(sorted(run.selected), ["a", "f"]);
  });

  it("does not leave the input set changed", () => {
    const before = new Set(["a"]);
    clickSelect(before, order, "a", "c", true);
    assert.deepEqual(sorted(before), ["a"]);
  });

  it("is a plain click with nothing clicked yet, the same video, or one no longer shown", () => {
    assert.deepEqual(sorted(clickSelect(new Set(), order, null, "c", true).selected), ["c"]);
    assert.deepEqual(sorted(clickSelect(new Set(["c"]), order, "c", "c", true).selected), []);
    const hidden = clickSelect(new Set(["z"]), order, "z", "c", true);
    assert.deepEqual(sorted(hidden.selected), ["c", "z"]);
    assert.equal(hidden.anchor, "c");
  });

  it("is listed in the keyboard shortcuts with this computer's Shift key", () => {
    for (const [apple, shift] of [[false, "Shift"], [true, "⇧"]] as const) {
      const group = shortcutGroups(apple).find((g) => g.title === "In My videos, while selecting");
      assert.ok(group, "a group for the library");
      assert.deepEqual(group.shortcuts[0].keys, [[shift, "Click"], [shift, "Space"]]);
    }
  });
});
