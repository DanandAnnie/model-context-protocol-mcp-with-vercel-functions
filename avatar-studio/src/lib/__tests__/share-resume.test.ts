import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RESUME_KEEP_MS, RESUME_MAX, placeAt, readPlaces, resumeOffer, type ResumePlaces } from "../share-resume";

const now = 1_800_000_000_000;

describe("share resume", () => {
  it("keeps a place from ten seconds in, to the whole second, and offers it back", () => {
    const places = placeAt({}, "vid_a", 83.7, 300, now);
    assert.deepEqual(places, { vid_a: { t: 83, at: now } });
    assert.equal(resumeOffer(places, "vid_a", 300, now + 1000), 83);
    assert.equal(resumeOffer(places, "vid_b", 300, now), null, "another video has none");
  });

  it("keeps nothing in the first ten seconds or the last ten, and clears what was kept", () => {
    assert.deepEqual(placeAt({}, "vid_a", 9.9, 300, now), {});
    const kept = placeAt({}, "vid_a", 120, 300, now);
    assert.deepEqual(placeAt(kept, "vid_a", 291, 300, now), {}, "near the end: watched, so cleared");
    assert.deepEqual(placeAt(kept, "vid_a", 3, 300, now), {}, "started over: cleared");
    assert.deepEqual(placeAt({}, "vid_a", 50, undefined, now), { vid_a: { t: 50, at: now } }, "length not known yet");
    assert.deepEqual(placeAt({}, "vid_a", 5, undefined, now), {}, "length not known: ten seconds in");
  });

  it("scales the limits for a short video: from a quarter in, not in its last 15%", () => {
    // 12 seconds: from 3 s in, to before 10.2 s.
    assert.deepEqual(placeAt({}, "vid_a", 2.9, 12, now), {});
    assert.deepEqual(placeAt({}, "vid_a", 3.2, 12, now), { vid_a: { t: 3, at: now } });
    assert.deepEqual(placeAt({}, "vid_a", 10.1, 12, now), { vid_a: { t: 10, at: now } });
    assert.deepEqual(placeAt({}, "vid_a", 10.3, 12, now), {});
    const kept = placeAt({}, "vid_a", 6, 12, now);
    assert.equal(resumeOffer(kept, "vid_a", 12, now), 6);
    assert.equal(resumeOffer(kept, "vid_a", undefined, now), null, "not until the length is known");
    assert.equal(resumeOffer(kept, "vid_a", 7, now), null, "a video since made shorter");
    // A minute: from ten seconds in (a quarter would be later), to before its last nine (15%).
    assert.deepEqual(placeAt({}, "vid_a", 9.5, 60, now), {});
    assert.deepEqual(placeAt({}, "vid_a", 51.2, 60, now), {});
    assert.deepEqual(placeAt({}, "vid_a", 50.9, 60, now), { vid_a: { t: 50, at: now } });
  });

  it("does not offer an expired place, one too early, or one the video no longer reaches", () => {
    const places: ResumePlaces = { a: { t: 60, at: now - RESUME_KEEP_MS }, b: { t: 5, at: now }, c: { t: 95, at: now } };
    assert.equal(resumeOffer(places, "a", 300, now), null);
    assert.equal(resumeOffer(places, "b", 300, now), null);
    assert.equal(resumeOffer(places, "c", 100, now), null, "within the last ten seconds of a video since made shorter");
    assert.equal(resumeOffer(places, "c", undefined, now), 95);
  });

  it("drops expired places and keeps the most recent fifty", () => {
    let places: ResumePlaces = { old: { t: 30, at: now - RESUME_KEEP_MS - 1 } };
    for (let i = 0; i < RESUME_MAX + 5; i++) places = placeAt(places, `v${i}`, 30, 300, now + i);
    assert.equal(Object.keys(places).length, RESUME_MAX);
    assert.equal(places.old, undefined);
    assert.equal(places.v0, undefined, "the oldest went first");
    assert.ok(places[`v${RESUME_MAX + 4}`]);
  });

  it("reads only well-formed places from what the browser holds", () => {
    assert.deepEqual(readPlaces(null), {});
    assert.deepEqual(readPlaces("not json"), {});
    assert.deepEqual(readPlaces("[1,2]"), {});
    assert.deepEqual(readPlaces(JSON.stringify({ a: { t: 40, at: now }, b: { t: "40", at: now }, c: null, d: { t: -1, at: now }, e: { t: 40 } })), { a: { t: 40, at: now } });
  });
});
