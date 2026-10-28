// The <Picture N> labels a description uses for the pictures a b-roll clip features: which name no picture, and how
// they are renumbered when a picture is removed.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { danglingLabels, pictureLabels, withPictureRemoved } from "../picture-labels";

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
});
