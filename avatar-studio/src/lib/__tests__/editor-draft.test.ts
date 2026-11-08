// The editor's unsent draft as Home sums it up: kept per space, read only in the shape this build expects.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRAFT_KEY, DRAFT_OPENING_MAX, draftKeyFor, draftSummary, restorableScenes } from "../editor-draft";

const saved = "2026-11-02T08:00:00.000Z";
const raw = (d: unknown) => JSON.stringify(d);

describe("draft key", () => {
  it("keeps Personal's draft at the original key and each workspace's at its own", () => {
    assert.equal(draftKeyFor({ personalId: "u_1", activeId: "u_1" }), DRAFT_KEY);
    assert.equal(draftKeyFor({ personalId: "u_1", activeId: "ws_9" }), `${DRAFT_KEY}:ws_9`);
    assert.equal(draftKeyFor(null), null, "no key while the space is not known");
  });
});

describe("draft summary", () => {
  it("sums up the title, scenes, words, opening words, and when it was saved", () => {
    const s = draftSummary(raw({ title: "  Open house ", scenes: [{ script: "Welcome to   12 Oak Lane.\nCome in." }, { script: "The kitchen is new." }], savedAt: saved }));
    assert.deepEqual(s, { title: "Open house", scenes: 2, words: 11, opening: "Welcome to 12 Oak Lane. Come in.", savedAt: saved });
  });

  it("starts from the first scene with words, and does not count pause markers as words", () => {
    const s = draftSummary(raw({ title: "", scenes: [{ script: "  " }, { script: "Hello [pause 1s] there." }], savedAt: saved }));
    assert.equal(s?.opening, "Hello there.");
    assert.equal(s?.words, 2);
    assert.equal(s?.title, "");
  });

  it("cuts a long opening with an ellipsis, never through a character a reader sees as one", () => {
    for (const emoji of ["🏡", "👍🏽", "🇺🇸", "👨‍👩‍👧"]) {
      const long = `${"a".repeat(DRAFT_OPENING_MAX - 2)}${emoji}${emoji} and more`;
      const opening = draftSummary(raw({ scenes: [{ script: long }], savedAt: saved }))!.opening;
      assert.ok(opening.endsWith(`a${emoji}…`), `${emoji}: ${opening.slice(-12)}`);
    }
    assert.equal(draftSummary(raw({ scenes: [{ script: "a".repeat(DRAFT_OPENING_MAX) }] }))!.opening, "a".repeat(DRAFT_OPENING_MAX), "at the limit it is kept whole");
  });

  it("has no draft the editor would not restore", () => {
    for (const value of [null, "", "not json", "null", "42", raw({ title: "x", scenes: [] }), raw({ title: "x" }), raw({ scenes: "Hello" }), raw({ scenes: [{ script: "Hi." }, null] }), raw({ scenes: [{ script: 3 }] }), raw({ scenes: [{}] })]) {
      assert.equal(draftSummary(value), null, String(value));
    }
    assert.equal(restorableScenes([{ script: "" }]), true, "a scene with no words yet is still a scene");
    assert.equal(restorableScenes([{ script: "Hi." }, "Hi."]), false);
  });

  it("reads the title and saved time only in the shape this build writes them", () => {
    const s = draftSummary(raw({ title: 7, scenes: [{ script: "" }, { script: "Hi." }], savedAt: "yesterday" }));
    assert.deepEqual(s, { title: "", scenes: 2, words: 1, opening: "Hi.", savedAt: "" });
  });
});
