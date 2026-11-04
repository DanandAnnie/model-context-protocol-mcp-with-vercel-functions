// The Video translate page's list: its status filter and what its search looks through. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TRANSLATION_FILTERS, translationCounts, translationFilterFrom, translationState, translationTexts } from "../translation-filter";

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
