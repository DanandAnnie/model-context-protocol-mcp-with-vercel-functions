// The clip a library card plays while hovered: a finished render's own file, out of the trash, at a web address.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CARD_PREVIEW_DELAY_MS, cardPreviewSrc } from "../client";

describe("card preview", () => {
  it("plays a finished render's file, at a web address or a path on this site", () => {
    assert.equal(cardPreviewSrc({ status: "completed", videoUrl: "https://cdn.example.com/v.mp4" }), "https://cdn.example.com/v.mp4");
    assert.equal(cardPreviewSrc({ status: "completed", videoUrl: "HTTP://cdn.example.com/v.mp4" }), "HTTP://cdn.example.com/v.mp4");
    assert.equal(cardPreviewSrc({ status: "completed", videoUrl: "/demo/render.webm" }), "/demo/render.webm");
  });

  it("has nothing to play for a render under way or failed, in the trash, or with no file", () => {
    for (const status of ["queued", "processing", "failed"]) assert.equal(cardPreviewSrc({ status, videoUrl: "https://cdn.example.com/v.mp4" }), undefined, status);
    assert.equal(cardPreviewSrc({ status: "completed", videoUrl: "https://cdn.example.com/v.mp4", deletedAt: "2026-11-01T00:00:00.000Z" }), undefined);
    assert.equal(cardPreviewSrc({ status: "completed" }), undefined);
    assert.equal(cardPreviewSrc({ status: "completed", videoUrl: "" }), undefined);
  });

  it("plays nothing at any other kind of address", () => {
    for (const videoUrl of ["javascript:alert(1)", "data:video/mp4;base64,AAAA", "//evil.example/v.mp4", "/\\evil.example/v.mp4", "/\t/evil.example/v.mp4", "/ /evil.example", "blob:https://x/1", "v.mp4"]) {
      assert.equal(cardPreviewSrc({ status: "completed", videoUrl }), undefined, videoUrl);
    }
  });

  it("waits a moment before playing, so a pointer passing over the grid loads nothing", () => {
    assert.ok(CARD_PREVIEW_DELAY_MS >= 200 && CARD_PREVIEW_DELAY_MS <= 600);
  });
});
