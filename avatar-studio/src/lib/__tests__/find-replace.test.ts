// Find and replace across scenes: counts, case and whole-word matching, and pause markers left whole.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countMatches, replaceAll } from "../find-replace";

describe("find and replace", () => {
  const scenes = ["Welcome to 12 Maple Street. [pause 2s] Maple trees line it.", "Call Dana about maple floors.", "Maplewood is next door."];

  it("counts and replaces in every scene, ignoring case unless asked", () => {
    assert.deepEqual(countMatches(scenes, "maple"), [2, 1, 1]);
    assert.deepEqual(countMatches(scenes, "Maple", { matchCase: true }), [2, 0, 1]);
    assert.deepEqual(countMatches(scenes, "maple", { wholeWord: true }), [2, 1, 0]);
    const { scripts, count } = replaceAll(scenes, "Maple Street", "Oak Lane");
    assert.equal(count, 1);
    assert.equal(scripts[0], "Welcome to 12 Oak Lane. [pause 2s] Maple trees line it.");
    assert.equal(scripts[1], scenes[1]);
  });

  it("takes the replacement literally and never touches a pause marker", () => {
    assert.deepEqual(replaceAll(["Price $5 [pause 2s] now."], "$5", "$10 ($&)").scripts, ["Price $10 ($&) [pause 2s] now."]);
    assert.deepEqual(countMatches(["Hold on. [pause 2s] And [Pause]."], "pause"), [0]);
    assert.deepEqual(replaceAll(["Wait [pause 2s] for 2s."], "2s", "two seconds").scripts, ["Wait [pause 2s] for two seconds."]);
    assert.deepEqual(replaceAll(scenes, "", "x"), { scripts: scenes, count: 0 });
    // Words in other scripts count as words too.
    assert.deepEqual(countMatches(["Café ÉCOLE école"], "école", { wholeWord: true }), [2]);
  });
});
