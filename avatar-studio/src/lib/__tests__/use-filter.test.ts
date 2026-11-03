// The Avatars and Voices pages' "Use in videos" filter, by how many videos need each presenter or voice.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { passesUse } from "../client";

describe("passesUse", () => {
  const counts = { anna: 2, ben: 0, constructor: 1 };
  it("lets everything through when either will do", () => {
    assert.equal(passesUse(counts, "anna", "all"), true);
    assert.equal(passesUse(undefined, "anna", "all"), true);
  });

  it("keeps only the ones some video needs, or only those none does", () => {
    assert.equal(passesUse(counts, "anna", "used"), true);
    assert.equal(passesUse(counts, "anna", "unused"), false);
    assert.equal(passesUse(counts, "ben", "used"), false);
    assert.equal(passesUse(counts, "ben", "unused"), true);
    assert.equal(passesUse(counts, "nobody", "unused"), true);
    // Counts not read yet list nothing as either.
    assert.equal(passesUse(undefined, "anna", "unused"), false);
    assert.equal(passesUse(undefined, "anna", "used"), false);
  });

  it("reads an id's own count only", () => {
    assert.equal(passesUse(counts, "constructor", "used"), true);
    assert.equal(passesUse({ anna: 1 }, "toString", "used"), false);
    assert.equal(passesUse({ anna: 1 }, "__proto__", "unused"), true);
  });
});
