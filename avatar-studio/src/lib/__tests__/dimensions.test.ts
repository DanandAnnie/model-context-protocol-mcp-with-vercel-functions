import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dimensionsFor } from "../types";

describe("dimensionsFor", () => {
  it("defaults to full HD and scales 720p from the same aspect", () => {
    assert.deepEqual(dimensionsFor("16:9"), { width: 1920, height: 1080 });
    assert.deepEqual(dimensionsFor("16:9", "720p"), { width: 1280, height: 720 });
    assert.deepEqual(dimensionsFor("9:16", "720p"), { width: 720, height: 1280 });
    assert.deepEqual(dimensionsFor("1:1", "720p"), { width: 720, height: 720 });
    assert.deepEqual(dimensionsFor("1:1", "1080p"), { width: 1080, height: 1080 });
  });
});
