// The browser's API helper: how an answer, a refusal, and no answer at all come back, which decides whether a page keeps
// its idempotency key for a retry. Run with: npm test
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ApiError, api, isRefusal } from "../client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("api client", () => {
  it("says plainly when no answer came back, keeping the key for the retry", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const err = await api("/api/x").catch((e: unknown) => e);
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 0);
    assert.match((err as Error).message, /could not be reached/);
    assert.equal(isRefusal(err), false, "a start that may have gone through keeps its key");
  });

  it("passes a cancelled request on as it is", async () => {
    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as typeof fetch;
    await assert.rejects(api("/api/x"), (e: unknown) => e instanceof DOMException && e.name === "AbortError");
  });

  it("counts only a 4xx answer as a refusal, never a start still being sent", () => {
    assert.equal(isRefusal(new ApiError("Fill in Open time", 400)), true);
    assert.equal(isRefusal(new ApiError("Too many", 429)), true);
    assert.equal(isRefusal(new ApiError("This render is still being sent; try again in a moment", 409)), false);
    assert.equal(isRefusal(new ApiError("Key used for another", 409)), true);
    assert.equal(isRefusal(new ApiError("Bad gateway", 502)), false);
    assert.equal(isRefusal(new Error("x")), false);
  });
});
