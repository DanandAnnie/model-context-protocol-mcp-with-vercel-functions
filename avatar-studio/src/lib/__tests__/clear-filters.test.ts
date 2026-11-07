// Clear filters in the library takes the filters off the address too, and keeps what is not a filter.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIBRARY_FILTER_PARAMS, withoutLibraryFilters } from "../client";

describe("withoutLibraryFilters", () => {
  it("leaves an address without filters alone", () => {
    assert.equal(withoutLibraryFilters(""), null);
    assert.equal(withoutLibraryFilters("utm_source=mail"), null);
  });

  it("takes off every filter the library reads, and a batch's results", () => {
    assert.equal(withoutLibraryFilters("share=expiring"), "");
    assert.equal(withoutLibraryFilters("?status=failed&created=7d"), "");
    assert.equal(withoutLibraryFilters("batch=b1&skipped=2&failed=1"), "");
    assert.equal(withoutLibraryFilters(LIBRARY_FILTER_PARAMS.map((k) => `${k}=x`).join("&")), "");
  });

  it("keeps what is not a filter, in its order", () => {
    assert.equal(withoutLibraryFilters("utm_source=mail&presenter=stock_5&ref=home"), "?utm_source=mail&ref=home");
    assert.equal(withoutLibraryFilters("voice=stock_voice_1&voice=again&x=1"), "?x=1");
  });
});
