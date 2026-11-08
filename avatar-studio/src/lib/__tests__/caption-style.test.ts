// Caption styles kept by the editor, the brand kit, and the Video Agent's hand-off.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captionStyleWithoutDefaults, restoredCaptionStyle } from "../caption-style";
import { DEFAULT_CAPTION_STYLE } from "../types";

describe("restoredCaptionStyle", () => {
  it("keeps a style this build offers, leaving out the default look and font", () => {
    assert.deepEqual(restoredCaptionStyle({ position: "top", size: "large", look: "bold", font: "mono" }), { position: "top", size: "large", look: "bold", font: "mono" });
    assert.deepEqual(restoredCaptionStyle({ position: "top", size: "small", look: "classic", font: "sans" }), { position: "top", size: "small" });
  });

  it("falls back to the default for values another build offered, and for anything that is not a style", () => {
    assert.deepEqual(restoredCaptionStyle({ position: "middle", size: "huge", look: "neon", font: "comic" }), DEFAULT_CAPTION_STYLE);
    assert.deepEqual(restoredCaptionStyle(null), DEFAULT_CAPTION_STYLE);
    assert.deepEqual(restoredCaptionStyle("bold"), DEFAULT_CAPTION_STYLE);
  });
});

describe("captionStyleWithoutDefaults", () => {
  it("drops the classic look and sans font, which an unset one means", () => {
    assert.deepEqual(captionStyleWithoutDefaults({ position: "bottom", size: "medium", look: "classic", font: "serif" }), { position: "bottom", size: "medium", font: "serif" });
  });
});
