// The <Picture N> labels a description uses for the pictures a b-roll clip features: which name no picture, and how
// they are renumbered when a picture is removed.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { danglingLabels, insertPictureLabel, pictureLabels, withPictureRemoved } from "../picture-labels";

describe("picture labels", () => {
  it("are read in order, and a label past the pictures featured names nothing", () => {
    const prompt = "The shoe in <Picture 1> on the track in <Picture 2>, then <Picture 1> again and <picture 3>";
    assert.deepEqual(pictureLabels(prompt), [1, 2, 1, 3]);
    assert.deepEqual(danglingLabels(prompt, 3), []);
    assert.deepEqual(danglingLabels(prompt, 2), [3]);
    assert.deepEqual(danglingLabels(prompt, 0), [1, 2, 3]);
    assert.deepEqual(danglingLabels("A <Picture 0> shot", 1), [0]);
    assert.deepEqual(danglingLabels("No labels at all", 0), []);
  });

  it("follow the pictures when one is removed: its label goes and later ones move down", () => {
    const prompt = "The shoe in <Picture 1> on the track in <Picture 2> under <Picture 3>";
    assert.equal(withPictureRemoved(prompt, 1), "The shoe in on the track in <Picture 1> under <Picture 2>");
    assert.equal(withPictureRemoved(prompt, 2), "The shoe in <Picture 1> on the track in under <Picture 2>");
    assert.equal(withPictureRemoved(prompt, 3), "The shoe in <Picture 1> on the track in <Picture 2> under");
    assert.equal(withPictureRemoved("<Picture 1> runs past <Picture 2>", 1), "runs past <Picture 1>");
    assert.equal(withPictureRemoved("No labels", 1), "No labels");
  });

  it("go in where the cursor is, spaced from the words around, never breaking a label or cutting text", () => {
    const L = "<Picture 1>";
    assert.deepEqual(insertPictureLabel("A desk", L, 0, 0, 100), { text: "<Picture 1> A desk", caret: 11 });
    assert.deepEqual(insertPictureLabel("A desk", L, 6, 6, 100), { text: "A desk <Picture 1>", caret: 18 });
    assert.equal(insertPictureLabel("scene with", L, 6, 6, 100)!.text, "scene <Picture 1> with");
    assert.equal(insertPictureLabel("on the table.", L, 12, 12, 100)!.text, "on the table <Picture 1>.", "punctuation stays attached");
    // A selection is replaced, unless it touches a label.
    assert.equal(insertPictureLabel("the red shoe", L, 4, 7, 100)!.text, "the <Picture 1> shoe");
    assert.equal(insertPictureLabel("the <Picture 2> track", L, 6, 13, 100)!.text, "the <Picture 2> <Picture 1> track");
    // A cursor inside a label moves past it.
    assert.equal(insertPictureLabel("the <Picture 2> track", L, 8, 8, 100)!.text, "the <Picture 2> <Picture 1> track");
    // No room: nothing is cut.
    assert.equal(insertPictureLabel("a".repeat(95), L, 3, 3, 100), null);
    assert.ok(insertPictureLabel("a".repeat(88), L, 88, 88, 100));
  });
});
