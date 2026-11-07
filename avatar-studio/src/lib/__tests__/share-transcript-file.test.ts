import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transcriptFileName, transcriptText } from "../share-transcript-file";

const cues = [
  { startMs: 0, text: "Welcome to the tour." },
  { startMs: 5_400, text: "First we open\nthe doors." },
  { startMs: 9_000, text: "   " },
  { startMs: 65_000, text: "Finally,  the keys." },
];

describe("share transcript file", () => {
  it("writes the title, then one line per caption with its time", () => {
    assert.equal(
      transcriptText(cues, { title: "House tour", times: true }),
      "House tour\n\n0:00  Welcome to the tour.\n0:05  First we open the doors.\n1:05  Finally, the keys.\n",
    );
  });

  it("names a translated transcript's language, and can leave the times out", () => {
    assert.equal(
      transcriptText(cues.slice(0, 2), { title: "House tour", language: "Spanish", times: false }),
      "House tour · Spanish\n\nWelcome to the tour.\nFirst we open the doors.\n",
    );
    assert.equal(transcriptText([{ startMs: 0, text: "Hi." }], { title: "  ", times: false }), "Hi.\n", "no heading without a title");
    assert.equal(transcriptText([], { title: "Empty", times: true }), "Empty\n\n");
    assert.equal(transcriptText([{ startMs: 0, text: "Hi." }], { title: "Two\nlines\tand tab", times: false }), "Two lines and tab\n\nHi.\n", "a title stays one line");
  });

  it("names the file after the video, safe to save, with the language when translated", () => {
    assert.equal(transcriptFileName("House tour"), "House tour transcript.txt");
    assert.equal(transcriptFileName("House tour", "Spanish"), "House tour transcript (Spanish).txt");
    assert.equal(transcriptFileName('Q3: "plan" / review?'), "Q3 plan review transcript.txt");
    assert.equal(transcriptFileName("notes.txt"), "notes transcript.txt");
    assert.equal(transcriptFileName("   "), "Video transcript.txt");
    const long = "x".repeat(100);
    const plain = transcriptFileName(long);
    const spanish = transcriptFileName(long, "Spanish");
    assert.match(plain, /^x+ transcript\.txt$/, "a long title is cut, never the ending");
    assert.match(spanish, /^x+ transcript \(Spanish\)\.txt$/);
    assert.notEqual(plain, spanish);
    assert.ok([...plain].length <= 84 && [...spanish].length <= 84);
  });
});
