// Listening to a whole video's script: the pieces a voice preview takes and what plays for each scene.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PREVIEW_CHARS, previewChunks, previewPlaylist } from "../script-preview";
import type { Scene, Voice } from "../types";

const bg = { type: "color" as const, value: "#fff" };
const sc = (over: Partial<Scene> = {}): Scene => ({ script: "Hello there.", background: bg, ...over });
const anna: Voice = { id: "v_anna", name: "Anna", provider: "mock" };
const ray: Voice = { id: "v_ray", name: "Ray", provider: "mock" };

describe("script preview", () => {
  it("keeps a short script whole, and cuts a long one at sentence ends within the limit", () => {
    assert.deepEqual(previewChunks("Welcome in. Let me show you around."), ["Welcome in. Let me show you around."]);
    const sentence = "This kitchen was redone last spring with new cabinets and stone counters. ";
    const long = sentence.repeat(20);
    const pieces = previewChunks(long);
    assert.ok(pieces.length > 1);
    for (const p of pieces) {
      assert.ok(p.length <= MAX_PREVIEW_CHARS, `${p.length}`);
      assert.ok(p.endsWith("counters."), p.slice(-20));
    }
    assert.equal(pieces.join(" "), long.trim());
  });

  it("cuts a sentence longer than the limit at a space, and keeps every character", () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const pieces = previewChunks(words, 100);
    for (const p of pieces) assert.ok(p.length <= 100);
    assert.equal(pieces.join(" "), words);
    assert.deepEqual(previewChunks("...and then? Yes", 600), ["...and then? Yes"]);
  });

  it("never cuts inside a pause marker, and leaves out a piece of nothing but pauses", () => {
    assert.deepEqual(previewChunks("One.[pause 1.5s] Two."), ["One.[pause 1.5s] Two."]);
    const pieces = previewChunks(`${"a ".repeat(45)}[pause 2.5s] ${"b ".repeat(20)}`, 100);
    assert.ok(pieces.some((p) => p.includes("[pause 2.5s]")), JSON.stringify(pieces));
    assert.equal(pieces.join(" ").replace(/\s+/g, " "), `${"a ".repeat(45)}[pause 2.5s] ${"b ".repeat(20)}`.trim().replace(/\s+/g, " "));
    assert.deepEqual(previewChunks("Hi. [pause 2s]", 4), ["Hi."]);
  });

  it("plays each scene in order: its words in its voice and pace, a clip, or a silent hold", () => {
    const scenes = [sc({ script: "First." }), sc({ script: "Second.", voiceId: "v_ray", speed: 1.25 }), sc({ audioId: "clip_1", script: "Said on the clip." }), sc({ script: "[pause 2s]" }), sc({ script: "" }), sc({ script: "Last." })];
    const items = previewPlaylist(scenes, (s) => (s.voiceId === "v_ray" ? ray : anna), 0.9);
    assert.deepEqual(items, [
      { scene: 0, kind: "speech", voice: anna, text: "First.", speed: 0.9 },
      { scene: 1, kind: "speech", voice: ray, text: "Second.", speed: 1.25 },
      { scene: 2, kind: "clip", clipId: "clip_1" },
      { scene: 3, kind: "silence", seconds: 2 },
      { scene: 5, kind: "speech", voice: anna, text: "Last.", speed: 0.9 },
    ]);
    assert.deepEqual(previewPlaylist([sc()], () => null, 1), []);
  });
});
