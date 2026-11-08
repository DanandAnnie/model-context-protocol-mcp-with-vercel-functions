// Home's shared folders card: opens of the folder pages in the last two weeks, and the folders opened most.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { folderOpens } from "../insights";

const now = Date.parse("2026-11-08T12:00:00Z");

describe("folderOpens", () => {
  it("counts the last 14 UTC days, today included, and nothing older", () => {
    const r = folderOpens([{ id: "a", folder: "Spring", viewsByDay: { "2026-11-08": 2, "2026-10-26": 1, "2026-10-25": 5 } }], now);
    assert.equal(r.total, 3, "Oct 26 is the 14th day back; Oct 25 is outside");
    assert.deepEqual(r.top, [{ id: "a", folder: "Spring", label: "Spring", opens: 3 }]);
  });

  it("ranks by opens, then by name as a person reads it, and keeps three", () => {
    const r = folderOpens(
      [
        { id: "1", folder: "b", viewsByDay: { "2026-11-07": 4 } },
        { id: "2", folder: "Open house 10", viewsByDay: { "2026-11-07": 2 } },
        { id: "3", folder: "Open house 9", viewsByDay: { "2026-11-07": 2 } },
        { id: "4", folder: "a", viewsByDay: { "2026-11-07": 1 } },
      ],
      now,
    );
    assert.deepEqual(r.top.map((f) => f.folder), ["b", "Open house 9", "Open house 10"]);
    assert.equal(r.total, 9);
    assert.equal(r.shared, 4);
  });

  it("names a folder by its page's title, and leaves out folders not opened lately", () => {
    const r = folderOpens(
      [
        { id: "1", folder: "Q4", title: "Homes for sale", viewsByDay: { "2026-11-01": 1 } },
        { id: "2", folder: "Old", viewsByDay: { "2026-09-01": 9 } },
        { id: "3", folder: "Never" },
      ],
      now,
    );
    assert.deepEqual(r.top, [{ id: "1", folder: "Q4", label: "Homes for sale", opens: 1 }]);
    assert.equal(r.shared, 3, "every shared folder counts as shared");
    assert.equal(r.total, 1);
    assert.deepEqual(folderOpens([], now), { shared: 0, total: 0, top: [] });
  });
});
