// The line a library row gives on a video's share link, as the card's badges say it. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shareSummary } from "../client";

const now = Date.parse("2026-11-01T12:00:00Z");
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

describe("share summary", () => {
  it("says why a link cannot be opened, in the badges' order of precedence", () => {
    assert.equal(shareSummary({ shareDisabled: true, shareExpiresAt: at(-1), shareStartsAt: at(5) }, now), "Link off");
    assert.equal(shareSummary({ shareExpiresAt: at(-1) }, now), "Expired");
    assert.equal(shareSummary({ shareStartsAt: at(5), shareExpiresAt: at(48) }, now), "Scheduled");
  });

  it("says when a live link stops, and whether it asks for a password", () => {
    assert.equal(shareSummary({ shareExpiresAt: at(72) }, now), "Expires in 3 days");
    assert.equal(shareSummary({ shareExpiresAt: at(5), shareLocked: true }, now), "Expires in 5 hours · Password");
    assert.equal(shareSummary({ shareLocked: true }, now), "Password");
    assert.equal(shareSummary({ shareDisabled: true, shareLocked: true }, now), "Link off · Password");
    assert.equal(shareSummary({ shareStartsAt: at(2), shareLocked: true }, now), "Scheduled · Password");
    assert.equal(shareSummary({ shareExpiresAt: at(-2), shareLocked: true }, now), "Expired · Password");
  });

  it("says nothing for an open link or a video in the trash", () => {
    assert.equal(shareSummary({}, now), undefined);
    assert.equal(shareSummary({ shareExpiresAt: at(24 * 30) }, now), undefined, "an expiry weeks away is not news");
    assert.equal(shareSummary({ deletedAt: at(-1), shareDisabled: true }, now), undefined);
  });
});
