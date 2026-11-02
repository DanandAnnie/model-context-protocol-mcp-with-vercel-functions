// The share link a library card copies: only once a viewer can open it, on the public origin. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendableShareLink } from "../client";

const now = Date.parse("2026-11-02T12:00:00Z");
const hour = 3_600_000;
const at = (ms: number) => new Date(now + ms).toISOString();
const done = { id: "vid_1", status: "completed" };

describe("sendableShareLink", () => {
  it("is the share page on the origin given, without a doubled slash", () => {
    assert.equal(sendableShareLink(done, "https://studio.example.com", now), "https://studio.example.com/share/vid_1");
    assert.equal(sendableShareLink(done, "https://studio.example.com/", now), "https://studio.example.com/share/vid_1");
  });

  it("is there for a live link, with a coming expiry, a go-live already past, a password, or an email gate", () => {
    for (const v of [
      { ...done, shareExpiresAt: at(hour) },
      { ...done, shareStartsAt: at(-hour) },
      { ...done, shareLocked: true, shareGate: true },
    ])
      assert.equal(sendableShareLink(v, "https://x", now), "https://x/share/vid_1");
  });

  it("is not there while a viewer cannot open the link", () => {
    for (const v of [
      { ...done, status: "processing" },
      { ...done, status: "failed" },
      { ...done, shareDisabled: true },
      { ...done, shareExpiresAt: at(-1) },
      // Expired from the moment it is due, as the share page counts it.
      { ...done, shareExpiresAt: at(0) },
      { ...done, shareStartsAt: at(hour) },
      { ...done, deletedAt: at(-hour) },
    ])
      assert.equal(sendableShareLink(v, "https://x", now), undefined, JSON.stringify(v));
  });
});
