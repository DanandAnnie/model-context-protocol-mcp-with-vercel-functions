// Saved views in the library: names, queries, replacing, the cap, and what is read back from the browser.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SAVED_VIEWS_MAX, SAVED_VIEW_NAME_MAX, readSavedViews, sameView, savedViewsKey, viewName, viewQuery, withSavedView, withoutSavedView } from "../saved-views";

describe("saved views", () => {
  it("keeps only the library's own search and filters, not a batch's results or anything else", () => {
    assert.equal(viewQuery("?status=failed&batch=b1&skipped=2&created=7d&ref=home"), "status=failed&created=7d");
    assert.equal(viewQuery("folder=&starred=1"), "folder=&starred=1");
    assert.equal(viewQuery("voice=a&voice=b"), "voice=a");
  });

  it("tidies names and cuts them by characters", () => {
    assert.equal(viewName("  Failed\n this   week "), "Failed this week");
    assert.equal(Array.from(viewName("é".repeat(60))).length, SAVED_VIEW_NAME_MAX);
    assert.equal(viewName("   "), "");
    // A name cut short drops the comma it was cut after; one that fits keeps its own ending.
    assert.equal(viewName("Portrait reels for the spring campaign, the long name"), "Portrait reels for the spring campaign");
    assert.equal(viewName("Ends with a dash -"), "Ends with a dash -");
    // A flag or a family emoji is one character, never cut in half.
    const family = "👨‍👩‍👧";
    assert.equal(viewName("x".repeat(SAVED_VIEW_NAME_MAX - 1) + family + "tail"), "x".repeat(SAVED_VIEW_NAME_MAX - 1) + family);
  });

  it("adds new views last and replaces one of the same name where it is", () => {
    let views = withSavedView([], "Failed", "status=failed");
    views = withSavedView(views, "Open houses", "folder=Open+houses");
    views = withSavedView(views, "failed", "status=failed&created=7d");
    assert.deepEqual(views, [
      { name: "failed", query: "status=failed&created=7d" },
      { name: "Open houses", query: "folder=Open+houses" },
    ]);
    assert.equal(withSavedView(views, "  ", "q=x"), views);
  });

  it("lets the oldest go past the cap", () => {
    let views = withSavedView([], "first", "q=1");
    for (let i = 2; i <= SAVED_VIEWS_MAX + 1; i++) views = withSavedView(views, `view ${i}`, `q=${i}`);
    assert.equal(views.length, SAVED_VIEWS_MAX);
    assert.equal(views[0].name, "view 2");
    assert.equal(views.at(-1)!.name, `view ${SAVED_VIEWS_MAX + 1}`);
  });

  it("removes a view by name, case aside", () => {
    const views = withSavedView(withSavedView([], "A", "q=a"), "B", "q=b");
    assert.deepEqual(withoutSavedView(views, "a"), [{ name: "B", query: "q=b" }]);
  });

  it("tells the same search and filters apart from others, whatever their order or spelling", () => {
    assert.ok(sameView("status=failed&created=7d", "?created=7d&status=failed"));
    assert.ok(sameView("folder=Open+house", "folder=Open%20house&batch=b1"));
    assert.ok(!sameView("folder=", ""));
    assert.ok(!sameView("status=failed", "status=completed"));
  });

  it("reads back only well-formed views", () => {
    assert.deepEqual(readSavedViews(null), []);
    assert.deepEqual(readSavedViews("not json"), []);
    assert.deepEqual(readSavedViews('{"name":"x"}'), []);
    assert.deepEqual(
      readSavedViews(JSON.stringify([{ name: " Mine ", query: "starred=1&batch=b" }, { name: "mine", query: "q=dup" }, { name: 3, query: "" }, null, { name: "Long", query: "q=" + "x".repeat(3000) }])),
      [{ name: "Mine", query: "starred=1" }],
    );
  });

  it("keeps each space's views apart", () => {
    assert.notEqual(savedViewsKey("ws_1"), savedViewsKey("ws_2"));
  });
});
