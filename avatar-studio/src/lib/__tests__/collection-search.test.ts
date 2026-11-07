// The search on a shared folder's page: which titles a visitor's words find, and what the page reads from its address.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COLLECTION_SEARCH_MAX, cutSearch, foldForSearch, searchFromAddress, titleMatches } from "../collection-search";

describe("titleMatches", () => {
  it("matches every title for an empty or blank search", () => {
    assert.equal(titleMatches("Kitchen tour", ""), true);
    assert.equal(titleMatches("Kitchen tour", "   "), true);
  });

  it("finds a part of a word, in any case", () => {
    assert.equal(titleMatches("Kitchen tour", "KITCH"), true);
    assert.equal(titleMatches("Kitchen tour", "garden"), false);
  });

  it("needs every word, in any order", () => {
    assert.equal(titleMatches("3 bed on Oak Street", "oak 3 bed"), true);
    assert.equal(titleMatches("3 bed on Oak Street", "oak 4"), false);
  });

  it("sets accents aside, both ways", () => {
    assert.equal(titleMatches("Café on Main", "cafe"), true);
    assert.equal(titleMatches("Cafe on Main", "café"), true);
  });

  it("compares a decomposed title with a composed search", () => {
    const decomposed = "Café tour";
    assert.equal(titleMatches(decomposed, "café"), true);
  });

  it("reads letters with no separable accent as their plain letters", () => {
    assert.equal(titleMatches("Łódź loft", "lodz"), true);
    assert.equal(titleMatches("Søndergade", "sondergade"), true);
    assert.equal(titleMatches("Große Straße", "grosse strasse"), true);
    assert.equal(titleMatches("Große Straße", "GROẞE"), true);
  });

  it("reads a Greek final sigma as any other", () => {
    assert.equal(titleMatches("ΟΔΟΣΗ", "οδος"), true);
    assert.equal(titleMatches("οδοσ", "ΟΔΟΣ"), true);
  });

  it("treats a search of accents alone as no search", () => {
    assert.equal(titleMatches("Kitchen tour", "\u0301"), true);
  });

  it("reads compatibility forms as their plain letters", () => {
    // Fullwidth letters, as some keyboards type them.
    assert.equal(titleMatches("Open house", "ｏｐｅｎ"), true);
  });
});

describe("foldForSearch", () => {
  it("folds case, accents, and Unicode form", () => {
    assert.equal(foldForSearch("Ünïcödé"), "unicode");
    assert.equal(foldForSearch("Café"), foldForSearch("Café"));
  });
});

describe("searchFromAddress", () => {
  it("takes the first value of ?q", () => {
    assert.equal(searchFromAddress("oak"), "oak");
    assert.equal(searchFromAddress(["oak", "elm"]), "oak");
  });

  it("is empty without one", () => {
    assert.equal(searchFromAddress(undefined), "");
    assert.equal(searchFromAddress(null), "");
    assert.equal(searchFromAddress([]), "");
  });

  it("cuts a long search to the longest kept, by character", () => {
    const long = "é".repeat(COLLECTION_SEARCH_MAX + 20);
    assert.equal(Array.from(searchFromAddress(long)).length, COLLECTION_SEARCH_MAX);
    // An emoji is one character, never cut in half.
    const emoji = "🏡".repeat(COLLECTION_SEARCH_MAX + 1);
    assert.equal(searchFromAddress(emoji), "🏡".repeat(COLLECTION_SEARCH_MAX));
  });
});

describe("cutSearch", () => {
  it("leaves a search of the longest kept or shorter as it is", () => {
    const max = "a".repeat(COLLECTION_SEARCH_MAX);
    assert.equal(cutSearch(max), max);
    assert.equal(cutSearch("oak"), "oak");
  });

  it("counts an emoji as one character, as the address does", () => {
    const emoji = "🏡".repeat(COLLECTION_SEARCH_MAX);
    assert.equal(cutSearch(emoji), emoji);
    assert.equal(cutSearch(emoji + "x"), emoji);
  });
});
