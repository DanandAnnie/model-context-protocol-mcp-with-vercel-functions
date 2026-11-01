// "Select all matching" loads up to BULK_MAX videos onto the library page and hands them to one bulk action, so the
// page size, the bulk action, and the links CSV must all take that many, and no more.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bulkVideoSchema, selectionLinksSchema, videoQuerySchema } from "../services";
import { BULK_MAX } from "../types";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `vid_${i}`);

describe("select all matching", () => {
  it("can load that many cards in one page", () => {
    assert.equal(videoQuerySchema.parse({ limit: String(BULK_MAX) }).limit, BULK_MAX);
    assert.throws(() => videoQuerySchema.parse({ limit: String(BULK_MAX + 1) }));
  });

  it("can hand all of them to every bulk action, and the links CSV", () => {
    for (const body of [
      { action: "delete" },
      { action: "restore" },
      { action: "purge" },
      { action: "move", folder: "Q4" },
      { action: "star", starred: true },
      { action: "share", shareDisabled: true },
      { action: "schedule", shareStartsAt: null },
      { action: "expire", shareExpiresAt: null },
      { action: "password", sharePassword: null },
      { action: "settings", shareDownload: true },
    ]) {
      assert.doesNotThrow(() => bulkVideoSchema.parse({ ...body, ids: ids(BULK_MAX) }), body.action);
      assert.throws(() => bulkVideoSchema.parse({ ...body, ids: ids(BULK_MAX + 1) }), body.action);
    }
    assert.doesNotThrow(() => selectionLinksSchema.parse({ ids: ids(BULK_MAX) }));
    assert.throws(() => selectionLinksSchema.parse({ ids: ids(BULK_MAX + 1) }));
  });
});
