// What the Templates page's search looks through: a script template's name, description, category, and words, and a
// saved template's name, description, and each scene's name and words, compared as the page's list searches compare.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldTerm } from "../glossary";
import { SCRIPT_TEMPLATES, savedTemplateTexts, scriptTemplateTexts } from "../templates";
import type { Scene } from "../types";

const finds = (texts: string[], q: string) => texts.some((t) => foldTerm(t).includes(foldTerm(q)));

describe("template search", () => {
  it("looks through a script template's name, description, category, and words", () => {
    const t = SCRIPT_TEMPLATES.find((x) => x.id === "listing-walkthrough")!;
    const texts = scriptTemplateTexts(t);
    assert.ok(finds(texts, t.title.slice(0, 8)), "the name");
    assert.ok(finds(texts, "real estate"), "the category, in any case");
    assert.ok(finds(texts, t.description.split(" ").slice(-2).join(" ")), "the description");
    const word = t.script.replace(/\[pause[^\]]*\]/gi, " ").split(/\s+/).find((w) => w.length > 6)!;
    assert.ok(finds(texts, word), `a word of the script (${word})`);
    assert.equal(finds(texts, "zzz-not-there"), false);
  });

  it("looks through a saved template's name, description, and each scene's name and words, not its pause markers", () => {
    const scenes = [
      { id: "s1", script: "Welcome to [pause 1s] Café Lumière.", name: "Opening" },
      { id: "s2", script: "Book a table tonight." },
    ] as unknown as Scene[];
    const texts = savedTemplateTexts({ title: "Restaurant promo", description: "For the spring menu", scenes });
    // Case and Unicode form fold (a name typed on macOS can arrive decomposed); accents still count.
    for (const q of ["restaurant", "SPRING", "opening", "table tonight", "Café Lumière".normalize("NFD")]) {
      assert.ok(finds(texts, q), q);
    }
    assert.equal(finds(texts, "cafe lumiere"), false, "an accent is part of the word");
    assert.equal(finds(texts, "pause"), false, "a pause marker is not a word");
    assert.deepEqual(savedTemplateTexts({ title: "Bare", scenes: [{ id: "s", script: "" } as unknown as Scene] }), ["Bare"], "nothing empty to look through");
  });
});
