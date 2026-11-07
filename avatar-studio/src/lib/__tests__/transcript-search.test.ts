import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TRANSCRIPT_QUERY_MAX, findInTranscript, markLine, matchesByLine, searchPhrase, stepMatch } from "../transcript-search";

const lines = ["Welcome to the launch.", "The launch date is Monday; the LAUNCH party is Friday.", "Café au lait at the  café.", "No match here."];

describe("transcript search", () => {
  it("finds every occurrence, ignoring case, in order, with offsets into the line", () => {
    const m = findInTranscript(lines, "launch");
    assert.deepEqual(m, [
      { line: 0, start: 15, end: 21 },
      { line: 1, start: 4, end: 10 },
      { line: 1, start: 31, end: 37 },
    ]);
    assert.equal(lines[1].slice(m[2].start, m[2].end), "LAUNCH");
  });

  it("ignores accents both ways, and runs of spaces", () => {
    const m = findInTranscript(lines, "cafe");
    assert.equal(m.length, 2);
    assert.deepEqual(m.map((x) => lines[x.line].slice(x.start, x.end)), ["Café", "café"]);
    assert.equal(findInTranscript(lines, "CAFÉ").length, 2);
    const spaced = findInTranscript(lines, "at the café");
    assert.equal(spaced.length, 1);
    assert.equal(lines[2].slice(spaced[0].start, spaced[0].end), "at the  café");
    assert.equal(findInTranscript(lines, "  the   launch ").length, 3, "a query's own spaces are trimmed and collapsed");
  });

  it("finds nothing for a blank query or one that is not there", () => {
    assert.deepEqual(findInTranscript(lines, ""), []);
    assert.deepEqual(findInTranscript(lines, "   "), []);
    assert.deepEqual(findInTranscript(lines, "tuesday"), []);
  });

  it("does not overlap occurrences, and keeps characters outside the basic plane whole", () => {
    assert.equal(findInTranscript(["aaaa"], "aa").length, 2);
    const emoji = ["Launch 🚀 day"];
    const m = findInTranscript(emoji, "🚀");
    assert.equal(emoji[0].slice(m[0].start, m[0].end), "🚀");
    const after = findInTranscript(emoji, "🚀 day");
    assert.equal(emoji[0].slice(after[0].start, after[0].end), "🚀 day");
  });

  it("marks the accents and selectors that follow a match with it", () => {
    const marked = (text: string, q: string) => findInTranscript([text], q).map((m) => text.slice(m.start, m.end));
    assert.deepEqual(marked("cafe\u0301 au lait", "cafe"), ["cafe\u0301"], "an accent written apart");
    assert.deepEqual(marked("cafe\u0301 au lait", "café"), ["cafe\u0301"]);
    assert.deepEqual(marked("e\u0301e\u0301", "ee"), ["e\u0301e\u0301"]);
    assert.deepEqual(marked("I \u2764\ufe0f it", "\u2764"), ["\u2764\ufe0f"], "an emoji's presentation selector");
    assert.deepEqual(marked("Press 1\ufe0f\u20e3 now", "1"), ["1\ufe0f\u20e3"], "a keycap");
  });

  it("folds letters by language rules, without merging different letters", () => {
    const n = (text: string, q: string) => findInTranscript([text], q).length;
    assert.equal(n("각 사람", "가"), 0, "a Hangul syllable is not found by another that shares its start");
    assert.equal(n("가방", "가"), 1);
    assert.equal(n("がっこう", "か"), 0, "the dakuten changes the letter");
    assert.equal(n("ΟΔΟΣ", "οδος"), 1, "final sigma");
    assert.equal(n("Straße", "strasse"), 1);
    assert.equal(n("the ﬁrst", "first"), 1, "a ligature");
    assert.deepEqual(
      findInTranscript(["Fuß"], "s").map((m) => [m.start, m.end]),
      [[2, 3]],
      "a character compared as two is marked once",
    );
  });

  it("cuts a very long query", () => {
    assert.equal(searchPhrase("x".repeat(TRANSCRIPT_QUERY_MAX + 50)).length, TRANSCRIPT_QUERY_MAX);
  });

  it("marks a line's matches with their index among all the matches", () => {
    const m = findInTranscript(lines, "launch");
    assert.deepEqual(markLine(lines[1], 1, m), [
      { text: "The " },
      { text: "launch", match: 1 },
      { text: " date is Monday; the " },
      { text: "LAUNCH", match: 2 },
      { text: " party is Friday." },
    ]);
    assert.deepEqual(markLine(lines[0], 0, m), [{ text: "Welcome to the " }, { text: "launch", match: 0 }, { text: "." }]);
    assert.deepEqual(markLine(lines[3], 3, m), [{ text: "No match here." }]);
    assert.deepEqual(markLine("", 9, m), [{ text: "" }]);
    const by = matchesByLine(m);
    assert.deepEqual([...by.entries()], [
      [0, [0, 1]],
      [1, [1, 3]],
    ]);
    assert.deepEqual(markLine(lines[1], 1, m, ...by.get(1)!), markLine(lines[1], 1, m), "the same pieces from the line's own range");
  });

  it("steps through matches and goes round at either end", () => {
    assert.equal(stepMatch(-1, 3), 0);
    assert.equal(stepMatch(-1, 3, true), 2);
    assert.equal(stepMatch(0, 3), 1);
    assert.equal(stepMatch(2, 3), 0);
    assert.equal(stepMatch(0, 3, true), 2);
    assert.equal(stepMatch(5, 3), 0, "a match past the end (after the lines changed) starts again");
    assert.equal(stepMatch(0, 0), -1);
  });
});
