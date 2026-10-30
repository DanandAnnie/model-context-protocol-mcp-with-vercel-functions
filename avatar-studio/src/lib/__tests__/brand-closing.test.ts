// The brand kit's closing scene: what the editor's Closing scene button puts at the end of a video.
// Run with: npm test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MemoryStore } from "../store/memory";
import { brandKitSchema, getBrandKit, saveBrandKit } from "../services";
import { MAX_CLOSING_SCRIPT, MAX_SCENE_TEXT } from "../types";

beforeEach(() => {
  globalThis.__avatarStudioStore = new MemoryStore();
});

const kit = (closingScene: unknown) => brandKitSchema.safeParse({ name: "Acme", primaryColor: "#4f46e5", closingScene });

describe("brand kit closing scene", () => {
  it("is saved trimmed, with its on-screen text only when there is some", async () => {
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#4f46e5", closingScene: { script: "  Call us today. [pause 1s] ", text: " acme.com " } }));
    assert.deepEqual((await getBrandKit())?.closingScene, { script: "Call us today. [pause 1s]", text: "acme.com" });
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#4f46e5", closingScene: { script: "Thanks for watching.", text: "" } }));
    assert.deepEqual((await getBrandKit())?.closingScene, { script: "Thanks for watching." });
  });

  it("is none when both are blank, and is left out of a kit saved without it", async () => {
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#4f46e5", closingScene: { script: " ", text: "" } }));
    assert.equal((await getBrandKit())?.closingScene, undefined);
    await saveBrandKit(brandKitSchema.parse({ name: "Acme", primaryColor: "#4f46e5" }));
    assert.equal((await getBrandKit())?.closingScene, undefined);
  });

  it("refuses on-screen text without words, a silent scene of the wrong length, and text over the limits", () => {
    const textOnly = kit({ script: "", text: "acme.com" });
    assert.equal(textOnly.success, false);
    assert.match(JSON.stringify(textOnly.error?.issues), /Add what the presenter says in the closing scene/);
    assert.equal(kit({ script: "[pause 0.5s]" }).success, false);
    assert.equal(kit({ script: "[pause 2s]" }).success, true);
    assert.equal(kit({ script: "[pause 10s] ".repeat(7).trim() }).success, false);
    assert.equal(kit({ script: "a".repeat(MAX_CLOSING_SCRIPT + 1) }).success, false);
    assert.equal(kit({ script: "Hi.", text: "x".repeat(MAX_SCENE_TEXT + 1) }).success, false);
  });

  it("reads the on-screen text as a scene's: one line, spaces collapsed, counted as a reader sees it", () => {
    const parsed = kit({ script: "Hi.", text: " acme.com \n\n   555-0100 " });
    assert.equal(parsed.success && parsed.data.closingScene?.text, "acme.com 555-0100");
    // A flag is one character to a reader, though two code points.
    assert.equal(kit({ script: "Hi.", text: "🇺🇸".repeat(MAX_SCENE_TEXT) }).success, true);
  });
});
