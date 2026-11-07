// The library's bulk bar refuses a selection bigger than one action takes, with how many to unselect, rather than
// sending it for the server to answer 400.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { overSelection } from "../client";
import { bulkVideoSchema } from "../services";
import { BULK_MAX } from "../types";

describe("overSelection", () => {
  it("lets a selection up to the limit through", () => {
    assert.equal(overSelection(1, BULK_MAX), null);
    assert.equal(overSelection(BULK_MAX, BULK_MAX), null);
  });

  it("says how many to unselect past it", () => {
    assert.equal(overSelection(BULK_MAX + 1, BULK_MAX), `One action takes up to ${BULK_MAX} videos and ${BULK_MAX + 1} are selected; unselect 1 first, or act on them in two goes.`);
    assert.match(overSelection(260, BULK_MAX)!, /260 are selected; unselect 60 first/);
  });

  it("refuses exactly what the server would", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `vid_${i}`);
    for (const n of [BULK_MAX, BULK_MAX + 1]) {
      const server = bulkVideoSchema.safeParse({ action: "delete", ids: ids(n) }).success;
      assert.equal(overSelection(n, BULK_MAX) === null, server, `${n} ids`);
    }
  });
});
