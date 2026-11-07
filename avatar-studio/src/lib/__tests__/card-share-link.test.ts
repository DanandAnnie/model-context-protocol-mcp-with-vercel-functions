// The share link a library card copies: only once a viewer can open it, on the public origin; and when the library
// should look at its share links again by itself. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHARE_RECHECK_MAX_MS, nextShareChange, sendableShareLink } from "../client";

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

describe("nextShareChange", () => {
  it("is the time to the soonest go-live or expiry still ahead among the videos", () => {
    assert.equal(nextShareChange([{ shareStartsAt: at(30 * 60_000) }, { shareExpiresAt: at(10 * 60_000) }, {}], now), 10 * 60_000);
    // One already past counts no more; the next one ahead does.
    assert.equal(nextShareChange([{ shareStartsAt: at(-hour), shareExpiresAt: at(20 * 60_000) }], now), 20 * 60_000);
  });

  it("looks again at each whole hour before an expiry, when an hours- or days-left badge changes", () => {
    assert.equal(SHARE_RECHECK_MAX_MS, hour);
    // 2h30 left reads "3 hours" until 2h are left, in 30 minutes.
    assert.equal(nextShareChange([{ shareExpiresAt: at(2.5 * hour) }], now), 0.5 * hour);
    assert.equal(nextShareChange([{ shareExpiresAt: at(30 * hour) }], now), hour);
    assert.equal(nextShareChange([{ shareExpiresAt: at(30 * hour + 5 * 60_000) }], now), 5 * 60_000);
    // A go-live a day away is looked at again within the hour all the same.
    assert.equal(nextShareChange([{ shareStartsAt: at(24 * hour) }], now), hour);
  });

  it("is undefined when nothing shown is due to change by itself", () => {
    assert.equal(nextShareChange([], now), undefined);
    assert.equal(nextShareChange([{}, { shareExpiresAt: at(-1) }, { shareStartsAt: at(0) }], now), undefined);
    assert.equal(nextShareChange([{ shareExpiresAt: "not a date", shareStartsAt: "" }], now), undefined);
    // A link switched off, or a video in the trash, changes only when someone changes it.
    assert.equal(nextShareChange([{ shareDisabled: true, shareExpiresAt: at(hour) }, { deletedAt: at(-hour), shareStartsAt: at(hour) }], now), undefined);
  });
});
