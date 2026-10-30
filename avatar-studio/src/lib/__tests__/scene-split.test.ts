// Splitting a scene at the cursor and merging a scene with the next.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeScenes, splitScene, splitScript } from "../scene-split";
import type { Scene } from "../types";

const bg = { type: "color" as const, value: "#fff" };

describe("splitScript", () => {
  it("cuts at the cursor, trimming the space either side", () => {
    assert.deepEqual(splitScript("Welcome home. Let's look around.", 13), ["Welcome home.", "Let's look around."]);
    assert.deepEqual(splitScript("First line.\n\nSecond line.", 12), ["First line.", "Second line."]);
  });

  it("refuses a cut with nothing on one side, or inside a pause marker", () => {
    assert.equal(splitScript("Hello.", 0), null);
    assert.equal(splitScript("Hello.", 6), null);
    assert.equal(splitScript("Hello.   ", 7), null);
    assert.equal(splitScript("Hi [pause 2s] there.", 8), null);
    assert.deepEqual(splitScript("Hi [pause 2s] there.", 13), ["Hi [pause 2s]", "there."]);
  });

  it("refuses a cut inside a word, but not between characters of text written without spaces", () => {
    assert.equal(splitScript("Welcome", 3), null);
    assert.equal(splitScript("It's 2026 now", 7), null);
    assert.deepEqual(splitScript("ようこそ。ご案内します。", 5), ["ようこそ。", "ご案内します。"]);
  });

  it("refuses to leave a side of only pauses that is too short or too long to be a silent scene", () => {
    assert.equal(splitScript("[pause 0.5s] Hello there.", 12), null);
    assert.deepEqual(splitScript("[pause 2s] Hello there.", 10), ["[pause 2s]", "Hello there."]);
  });
});

describe("splitScene", () => {
  it("keeps the presenter, voice, background, layout, and pace on both halves, and the on-screen text on the first", () => {
    const scene: Scene = { script: "One. Two.", background: { type: "image", value: "https://x.test/a.png", fit: "contain" }, avatarId: "a1", voiceId: "v1", speed: 1.1, layout: { scale: 0.8, x: 0.2, y: 0 }, overlay: { text: "Title", position: "top" } as Scene["overlay"] };
    const [a, b] = splitScene(scene, 4)!;
    assert.deepEqual(a, { ...scene, script: "One." });
    const { overlay: _o, ...rest } = scene;
    assert.deepEqual(b, { ...rest, script: "Two." });
  });

  it("does not split a scene that plays a recorded clip", () => {
    assert.equal(splitScene({ script: "One. Two.", background: bg, audioId: "clip_1" }, 4), null);
  });
});

describe("mergeScenes", () => {
  it("joins the words with a blank line and names nothing lost when the scenes match", () => {
    const r = mergeScenes({ script: "One.  ", background: bg, avatarId: "a1" }, { script: "  Two.", background: bg, avatarId: "a1" })!;
    assert.deepEqual(r, { scene: { script: "One.\n\nTwo.", background: bg, avatarId: "a1" }, lost: [] });
  });

  it("keeps the first scene's settings and names what the second had of its own", () => {
    const r = mergeScenes(
      { script: "One.", background: bg },
      { script: "Two.", background: { type: "color", value: "#000" }, avatarId: "a2", voiceId: "v2", speed: 0.9, layout: { scale: 1.2, x: 0, y: 0 }, overlay: { text: "Price", position: "bottom" } as Scene["overlay"] },
    )!;
    assert.deepEqual(r.lost, ["presenter", "presenter layout", "voice", "pace", "background"]);
    // The second's on-screen text is kept when the first has none.
    assert.deepEqual(r.scene, { script: "One.\n\nTwo.", background: bg, overlay: { text: "Price", position: "bottom" } });
    const both = mergeScenes({ script: "A", background: bg, overlay: { text: "X", position: "top" } as Scene["overlay"] }, { script: "B", background: bg, overlay: { text: "Y", position: "top" } as Scene["overlay"] })!;
    assert.deepEqual(both.lost, ["on-screen text"]);
    assert.equal(both.scene.overlay?.text, "X");
  });

  it("names only what the second scene renders with: no presenter when neither shows one, no voice when it is silent", () => {
    const image = { type: "image" as const, value: "https://x.test/a.png" };
    const hidden = mergeScenes({ script: "A", background: image, hidePresenter: true, avatarId: "a1", layout: { scale: 0.8, x: 0, y: 0 } }, { script: "B", background: image, hidePresenter: true })!;
    assert.deepEqual(hidden.lost, []);
    const silent = mergeScenes({ script: "A", background: bg, voiceId: "v1", speed: 1.2 }, { script: "[pause 2s]", background: bg })!;
    assert.deepEqual(silent.lost, []);
    assert.equal(silent.scene.script, "A\n\n[pause 2s]");
    const shown = mergeScenes({ script: "A", background: image, hidePresenter: true }, { script: "B", background: image, avatarId: "a2" })!;
    assert.deepEqual(shown.lost, ["choice to show or hide the presenter"]);
  });

  it("refuses to make a silent scene longer than one can be", () => {
    assert.equal(mergeScenes({ script: "[pause 10s] ".repeat(4).trim(), background: bg }, { script: "[pause 10s] ".repeat(3).trim(), background: bg }), null);
  });

  it("never merges a scene that plays a recorded clip", () => {
    assert.equal(mergeScenes({ script: "A", background: bg, audioId: "c" }, { script: "B", background: bg }), null);
    assert.equal(mergeScenes({ script: "A", background: bg }, { script: "B", background: bg, audioId: "c" }), null);
  });
});
