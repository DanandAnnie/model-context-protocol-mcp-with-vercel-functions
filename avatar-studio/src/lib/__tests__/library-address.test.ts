// The library writes its filters into its address, so a reload, a copied link, or Back from a video opens it as it was left.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIBRARY_FILTER_PARAMS, libraryAddress, libraryFilterKey } from "../client";

describe("libraryAddress", () => {
  it("is null when the address already says what the filters do", () => {
    assert.equal(libraryAddress("", {}), null);
    assert.equal(libraryAddress("", { status: null, folder: null }), null);
    assert.equal(libraryAddress("?status=failed&created=7d", { status: "failed", created: "7d" }), null);
    // A link's own spelling is kept: %20 and + are the same space.
    assert.equal(libraryAddress("?folder=Open%20house", { folder: "Open house" }), null);
    assert.equal(libraryAddress("?folder=", { folder: "" }), null);
  });

  it("sets, changes, and takes off filters", () => {
    assert.equal(libraryAddress("", { status: "failed" }), "?status=failed");
    assert.equal(libraryAddress("?status=failed", { status: "completed" }), "?status=completed");
    assert.equal(libraryAddress("?status=failed&shape=portrait", { status: null }), "?shape=portrait");
    assert.equal(libraryAddress("?status=failed", { status: null }), "");
    // Unfiled is an empty folder, as the API reads it.
    assert.equal(libraryAddress("", { folder: "" }), "?folder=");
    assert.equal(libraryAddress("", { q: "café tour", starred: "1" }), "?q=caf%C3%A9+tour&starred=1");
  });

  it("keeps every other parameter where it is", () => {
    assert.equal(libraryAddress("?batch=b1&skipped=2&ref=home", { status: "failed" }), "?batch=b1&skipped=2&ref=home&status=failed");
    assert.equal(libraryAddress("?folder=A&ref=home&viewed=no", { folder: "B", viewed: null }), "?folder=B&ref=home");
  });

  it("folds a repeated filter into the one value", () => {
    assert.equal(libraryAddress("?voice=a&voice=b", { voice: "a" }), "?voice=a");
  });

  it("writes only the library's own filters", () => {
    assert.ok(LIBRARY_FILTER_PARAMS.includes("q"));
    assert.ok(LIBRARY_FILTER_PARAMS.includes("starred"));
  });
});

describe("libraryFilterKey", () => {
  const key = (search: string) => libraryFilterKey(new URLSearchParams(search));

  it("tells an empty folder (Unfiled) from no folder (every folder)", () => {
    assert.notEqual(key("?folder="), key(""));
    assert.equal(key("?folder="), key("folder="));
  });

  it("reads only the library's filters, in its own order", () => {
    assert.equal(key("?ref=home"), key(""));
    assert.equal(key("?status=failed&created=7d"), key("?created=7d&status=failed"));
    assert.notEqual(key("?status=failed"), key("?status=completed"));
    assert.equal(key("?folder=Open+house"), key("?folder=Open%20house"));
  });
});
