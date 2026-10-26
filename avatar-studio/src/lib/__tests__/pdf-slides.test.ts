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

describe("slideAspect", () => {
  it("frames wide pages, 4:3 included, as landscape, tall ones as portrait, and near-square ones square", async () => {
    const { slideAspect } = await import("../pdf-slides");
    assert.deepEqual([slideAspect(960, 540), slideAspect(1024, 768), slideAspect(612, 792), slideAspect(540, 960), slideAspect(500, 500)], ["16:9", "16:9", "9:16", "9:16", "1:1"]);
  });
});

describe("slideScripts", () => {
  it("ends a line with a full stop only where speech is left open, never after a pause or a closing quote", () => {
    // A slide of only a pause stays a silent scene; a pause or quote at the end is not followed by a spoken stop.
    assert.deepEqual(slideScripts(["[pause 3s]", "Thanks for watching [pause 2s]", 'She said "go."', "Next steps (see below.)", "Our plan"]).scripts, ["[pause 3s]", "Thanks for watching [pause 2s]", 'She said "go."', "Next steps (see below.)", "Our plan."]);
  });

  it("counts the blank line between scenes, so a full deck joins to no more than the budget", () => {
    // 20 pages of 249 characters fit the raw budget (4980) but not once joined (4980 + 19 * 2 = 5018).
    const texts = Array.from({ length: 20 }, () => `${"a".repeat(248)}.`);
    const { scripts, truncated } = slideScripts(texts);
    assert.equal(truncated, true);
    assert.ok(scripts.join("\n\n").length <= 5000, `joined ${scripts.join("\n\n").length}`);
    // Text with no spaces (Chinese, say) is cut to its share exactly and still fits.
    const cjk = slideScripts(Array.from({ length: 20 }, () => "字".repeat(400)));
    assert.ok(cjk.scripts.join("\n\n").length <= 5000);
  });

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
