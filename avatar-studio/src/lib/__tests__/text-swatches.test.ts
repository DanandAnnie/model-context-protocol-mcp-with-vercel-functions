// One-click colours for a scene's on-screen text: white, then the brand kit's own colours.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contrastRatio, textHidden, textSwatches } from "../scene-text";

describe("textSwatches", () => {
  it("offers white alone without a brand kit", () => {
    assert.deepEqual(textSwatches(null), [{ label: "White", color: "#ffffff" }]);
    assert.deepEqual(textSwatches(undefined), [{ label: "White", color: "#ffffff" }]);
  });
  it("adds the kit's primary and accent colours, in lower case", () => {
    assert.deepEqual(textSwatches({ primaryColor: "#1D4ED8", accentColor: "#f59e0b" }), [
      { label: "White", color: "#ffffff" },
      { label: "Brand primary", color: "#1d4ed8" },
      { label: "Brand accent", color: "#f59e0b" },
    ]);
  });
  it("leaves out a brand colour that repeats one before it", () => {
    assert.deepEqual(textSwatches({ primaryColor: "#FFFFFF", accentColor: "#123456" }).map((s) => s.label), ["White", "Brand accent"]);
    assert.deepEqual(textSwatches({ primaryColor: "#123456", accentColor: "#123456" }).map((s) => s.label), ["White", "Brand primary"]);
  });
  it("ignores a colour that is not six-digit hex", () => {
    assert.deepEqual(textSwatches({ primaryColor: "blue", accentColor: "#abc" }).map((s) => s.label), ["White"]);
  });
});

describe("textHidden", () => {
  it("measures contrast as WCAG does", () => {
    assert.equal(contrastRatio("#ffffff", "#000000"), 21);
    assert.equal(contrastRatio("#0f766e", "#0f766e"), 1);
    assert.equal(contrastRatio("#000000", "#ffffff"), contrastRatio("#ffffff", "#000000"));
  });
  it("flags text the same as, or close to, a colour background", () => {
    assert.equal(textHidden("#0f766e", "#0F766E"), true);
    assert.equal(textHidden("#0f766e", "#117a72"), true);
    assert.equal(textHidden("#ffffff", "#f8fafc"), true);
  });
  it("leaves readable text, and anything that is not a hex colour, alone", () => {
    assert.equal(textHidden("#ffffff", "#0f766e"), false);
    assert.equal(textHidden("#f59e0b", "#0f766e"), false);
    assert.equal(textHidden("#ffffff", "https://example.com/a.jpg"), false);
  });
});
