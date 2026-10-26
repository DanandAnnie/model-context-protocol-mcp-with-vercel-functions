// Slide decks as PDF: how a page's text becomes a scene's draft script.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pageText, slideScripts } from "../pdf-slides";

describe("pageText", () => {
  it("reads runs in order, breaking lines where the page does and collapsing spaces", () => {
    const runs = [{ str: "Quarterly", hasEOL: false }, { str: "  review", hasEOL: true }, { str: "" }, { str: "• Revenue  up 12%", hasEOL: true }, { hasEOL: true }, { str: "   " }];
    assert.equal(pageText(runs), "Quarterly review\n• Revenue up 12%");
  });
});

describe("slideScripts", () => {
  it("turns titles and bullets into sentences, leaving finished ones alone", () => {
    const { scripts, truncated } = slideScripts(["Welcome aboard\n• Meet the team\n- Read the handbook.", "Questions?", ""]);
    assert.deepEqual(scripts, ["Welcome aboard. Meet the team. Read the handbook.", "Questions?", ""]);
    assert.equal(truncated, false);
  });

  it("keeps a long deck within the budget, giving short pages what they need and cutting the long ones at a word", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const { scripts, truncated } = slideScripts(["Short title", long, long], 200);
    assert.equal(truncated, true);
    assert.equal(scripts[0], "Short title.");
    const total = scripts.reduce((n, s) => n + s.length, 0);
    assert.ok(total <= 200, `total ${total}`);
    for (const s of scripts.slice(1)) {
      assert.match(s, /^word0 word1 .*word\d+…$/, "cut at a word, marked with an ellipsis");
      assert.ok(s.length > 80, "the long pages share the room the short one left");
    }
  });
});
