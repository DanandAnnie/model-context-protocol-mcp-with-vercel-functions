import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beaconAllowed, crossSiteBeacon } from "../beacon";

const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api/videos/vid_1/view", { method: "POST", headers });

describe("beacons", () => {
  it("rejects browser requests from other sites and lets same-origin or headerless ones through", () => {
    assert.equal(crossSiteBeacon(req({ "sec-fetch-site": "cross-site" })), true);
    assert.equal(crossSiteBeacon(req({ "sec-fetch-site": "same-site" })), true);
    assert.equal(crossSiteBeacon(req({ "sec-fetch-site": "same-origin" })), false);
    assert.equal(crossSiteBeacon(req({ "sec-fetch-site": "none" })), false);
    assert.equal(crossSiteBeacon(req()), false);
  });

  it("counts one viewer once per window and caps a video across forged addresses", () => {
    const id = `vid_${Date.now()}`;
    assert.equal(beaconAllowed(req({ "x-forwarded-for": "198.51.100.1" }), "cta", id, 3, 60_000), true);
    assert.equal(beaconAllowed(req({ "x-forwarded-for": "198.51.100.1" }), "cta", id, 3, 60_000), false, "same viewer again");
    assert.equal(beaconAllowed(req({ "x-forwarded-for": "198.51.100.2" }), "cta", id, 3, 60_000), true);
    assert.equal(beaconAllowed(req({ "x-forwarded-for": "198.51.100.3" }), "cta", id, 3, 60_000), true);
    assert.equal(beaconAllowed(req({ "x-forwarded-for": "198.51.100.4" }), "cta", id, 3, 60_000), false, "per-video ceiling");
    assert.equal(beaconAllowed(req({ "x-forwarded-for": "198.51.100.5" }), "view", id, 3, 60_000), true, "views are counted apart from clicks");
  });
});
