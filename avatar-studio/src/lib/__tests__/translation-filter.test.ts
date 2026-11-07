// The Video translate page's list: its status filter and what its search looks through. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TRANSLATION_FILTERS, TRANSLATION_SORTS, TRANSLATION_SORT_KEY, sortTranslations, translationCounts, translationFilterFrom, translationSortFrom, translationState, translationTexts } from "../translation-filter";

describe("translation status filter", () => {
  it("puts each dub in one state", () => {
    assert.equal(translationState({ status: "queued" }), "moving");
    assert.equal(translationState({ status: "processing" }), "moving");
    assert.equal(translationState({ status: "processing", proofreadStage: "preparing" }), "moving");
    assert.equal(translationState({ status: "processing", proofreadStage: "ready" }), "proofread");
    assert.equal(translationState({ status: "processing", proofreadStage: "dubbing" }), "moving");
    assert.equal(translationState({ status: "completed" }), "done");
    assert.equal(translationState({ status: "failed" }), "failed");
    // A dub that failed after its lines were ready is failed, not waiting on a reader.
    assert.equal(translationState({ status: "failed", proofreadStage: "ready" }), "failed");
  });

  it("counts every state and the whole list", () => {
    const counts = translationCounts([{ status: "queued" }, { status: "processing", proofreadStage: "ready" }, { status: "completed" }, { status: "completed" }, { status: "failed" }]);
    assert.deepEqual(counts, { all: 5, moving: 1, proofread: 1, done: 2, failed: 1 });
    assert.deepEqual(translationCounts([]), { all: 0, moving: 0, proofread: 0, done: 0, failed: 0 });
  });

  it("reads a filter typed anywhere, falling back to all", () => {
    for (const f of TRANSLATION_FILTERS) assert.equal(translationFilterFrom(f.value), f.value);
    assert.equal(translationFilterFrom("Failed"), "all");
    assert.equal(translationFilterFrom(null), "all");
    assert.equal(translationFilterFrom("constructor"), "all");
  });

  it("has a note for an empty result under every filter but all", () => {
    for (const f of TRANSLATION_FILTERS) assert.equal(!!f.none, f.value !== "all");
  });
});

describe("translation search texts", () => {
  it("looks through the title, the language, and the source video's site", () => {
    assert.deepEqual(translationTexts({ title: "Tour (German)", targetLanguage: "German", sourceVideoUrl: "https://media.acme-homes.test/a.mp4" }), ["Tour (German)", "German", "media.acme-homes.test"]);
    assert.deepEqual(translationTexts({ title: "Tour", targetLanguage: "German", sourceVideoUrl: "not a url" }), ["Tour", "German", ""]);
  });
});

describe("translation sorts", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
  const items = [
    { id: "t1", title: "Aardvark 10 (German)", targetLanguage: "German", createdAt: at(1) },
    { id: "t2", title: "part 2 (French)", targetLanguage: "French", createdAt: at(2) },
    { id: "t3", title: "Ébauche", targetLanguage: "german", createdAt: at(3) },
    { id: "t4", title: "Part 2 (French)", targetLanguage: "French", createdAt: at(3) },
  ];
  const ids = (sort: Parameters<typeof sortTranslations>[1]) => sortTranslations(items, sort, "en").map((t) => t.id);

  it("orders by when each was started, both ways, dubs started together as they came", () => {
    // t3 and t4 were started in the same moment: they keep the order the list gave them, either way.
    assert.deepEqual(ids("newest"), ["t3", "t4", "t2", "t1"]);
    assert.deepEqual(ids("oldest"), ["t1", "t2", "t3", "t4"]);
  });

  it("orders titles and languages as a reader would, digits by value, ignoring case and accents", () => {
    // "Aardvark" first, "Ébauche" as an E, and "part 2" equal to "Part 2", so the newer of those comes first.
    assert.deepEqual(ids("title"), ["t1", "t3", "t4", "t2"]);
    // French before German (either case), and within a language by title.
    assert.deepEqual(ids("language"), ["t4", "t2", "t1", "t3"]);
    // Digits by value: "Part 2" before "Part 10".
    const parts = [
      { id: "p10", title: "Part 10", targetLanguage: "French", createdAt: at(1) },
      { id: "p2", title: "Part 2", targetLanguage: "French", createdAt: at(2) },
    ];
    assert.deepEqual(sortTranslations(parts, "title", "en").map((t) => t.id), ["p2", "p10"]);
  });

  it("reads a sort remembered or typed anywhere, falling back to newest", () => {
    for (const s of TRANSLATION_SORTS) assert.equal(translationSortFrom(s.value), s.value);
    assert.equal(translationSortFrom("Title"), "newest");
    assert.equal(translationSortFrom(null), "newest");
    assert.equal(TRANSLATION_SORT_KEY, "avatar-studio:translations-sort");
  });

  it("leaves the list it was given as it was", () => {
    const before = items.map((t) => t.id);
    sortTranslations(items, "title", "en");
    assert.deepEqual(items.map((t) => t.id), before);
  });
});
