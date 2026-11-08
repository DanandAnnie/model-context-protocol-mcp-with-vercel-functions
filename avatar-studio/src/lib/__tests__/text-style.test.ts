// Giving one scene's on-screen text style (position, size, colour) to the others.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sameTextStyle, textStyleTargets, withTextStyle } from "../scene-text";

describe("sameTextStyle", () => {
  it("treats an absent position, size, or colour as the default", () => {
    assert.equal(sameTextStyle({ text: "A" }, { text: "B", position: "top", size: "medium", color: "#FFFFFF" }), true);
    assert.equal(sameTextStyle({ text: "A", color: "#0F766E" }, { text: "B", color: "#0f766e" }), true);
    assert.equal(sameTextStyle({ text: "A" }, { text: "A", position: "bottom" }), false);
    assert.equal(sameTextStyle({ text: "A" }, { text: "A", size: "large" }), false);
    assert.equal(sameTextStyle({ text: "A" }, { text: "A", color: "#000000" }), false);
  });
});

describe("withTextStyle", () => {
  it("keeps the scene's own words and takes the style, defaults left out", () => {
    assert.deepEqual(withTextStyle({ text: "Oak Lane", position: "bottom", size: "large", color: "#000000" }, { text: "Elm St" }), { text: "Oak Lane" });
    assert.deepEqual(withTextStyle({ text: "Oak Lane" }, { text: "Elm St", position: "center", size: "small", color: "#0F766E" }), {
      text: "Oak Lane",
      position: "center",
      size: "small",
      color: "#0f766e",
    });
  });
});

describe("textStyleTargets", () => {
  const styled = { text: "Elm St", position: "bottom" as const, color: "#0f766e" };
  it("names the other scenes with text shown another way", () => {
    assert.deepEqual(textStyleTargets([styled, { text: "Oak" }, undefined, { text: "Pine", position: "bottom", color: "#0F766E" }, { text: "Ash", size: "large" }], 0), [1, 4]);
  });
  it("leaves out scenes without words on screen", () => {
    assert.deepEqual(textStyleTargets([styled, { text: "   " }, undefined], 0), []);
  });
  it("offers nothing from a scene without text of its own", () => {
    assert.deepEqual(textStyleTargets([undefined, { text: "Oak" }], 0), []);
    assert.deepEqual(textStyleTargets([{ text: " " }, { text: "Oak" }], 0), []);
  });
});
