import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorMessage } from "../client";

describe("errorMessage", () => {
  it("prefers the first field issue over the generic schema error", () => {
    const body = { error: "Invalid request", issues: [{ path: ["shareCta", "url"], message: "The link must start with http:// or https://" }] };
    assert.equal(errorMessage(body, 400), "The link must start with http:// or https://");
  });

  it("falls back to the error text, then the status", () => {
    assert.equal(errorMessage({ error: "Not found" }, 404), "Not found");
    assert.equal(errorMessage({ error: "Invalid request", issues: [{ message: "" }] }, 400), "Invalid request");
    assert.equal(errorMessage({}, 502), "Request failed (502)");
  });
});
