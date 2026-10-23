import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { excerpt } from "../text";

describe("excerpt", () => {
  it("collapses whitespace and leaves short text alone", () => {
    assert.equal(excerpt("  Hello\n\nthere.  "), "Hello there.");
  });

  it("cuts at a word boundary with an ellipsis", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const out = excerpt(words, 50);
    assert.ok(out.length <= 50, out);
    assert.ok(out.endsWith("…"));
    assert.ok(!/word\d*…$/.test(out) || /\bword\d+…$/.test(out), "ends on a whole word");
    assert.equal(out, "word0 word1 word2 word3 word4 word5 word6 word7…");
  });

  it("cuts inside a word only when there is no earlier space", () => {
    assert.equal(excerpt("x".repeat(100), 20), `${"x".repeat(19)}…`);
  });
});
