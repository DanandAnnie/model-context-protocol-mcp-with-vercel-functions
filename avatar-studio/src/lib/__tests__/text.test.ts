import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { excerpt, formatTimestamp } from "../text";

describe("excerpt", () => {
  it("collapses whitespace and leaves short text alone", () => {
    assert.equal(excerpt("  Hello\n\nthere.  "), "Hello there.");
  });

  it("cuts at a word boundary with an ellipsis", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const out = excerpt(words, 50);
    assert.ok(out.length <= 50, out);
    assert.ok(out.endsWith("…"));
    assert.equal(out, "word0 word1 word2 word3 word4 word5 word6 word7…");
  });

  it("cuts inside a word only when there is no earlier space, and never inside a character", () => {
    assert.equal(excerpt("x".repeat(100), 20), `${"x".repeat(19)}…`);
    const emoji = "😀".repeat(30);
    const out = excerpt(emoji, 10);
    assert.equal(out, `${"😀".repeat(9)}…`);
    assert.equal(out.includes("\uFFFD"), false);
    assert.equal(excerpt("Hello there. Then some more words follow", 14), "Hello there…");
  });
});

describe("formatTimestamp", () => {
  it("reads like a player's clock, dropping fractions", () => {
    assert.equal(formatTimestamp(0), "0:00");
    assert.equal(formatTimestamp(5.9), "0:05");
    assert.equal(formatTimestamp(65.4), "1:05");
    assert.equal(formatTimestamp(600), "10:00");
    assert.equal(formatTimestamp(3725), "1:02:05");
    assert.equal(formatTimestamp(-3), "0:00");
  });
});
