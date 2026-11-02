// A video's comments as a spreadsheet: row order, thread numbers, and what each column holds.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMENT_CSV_COLUMNS, commentRows } from "../comment-list";
import { parseCsv, toCsv } from "../csv";
import { formatTimestamp } from "../text";
import type { VideoComment } from "../types";

const note = (id: string, createdAt: string, extra: Partial<VideoComment> = {}): VideoComment => ({ id, ownerId: "ws_a", videoId: "vid_1", authorId: "user_a", authorEmail: "a@example.com", text: `Text of ${id}`, createdAt, ...extra });

describe("comment rows", () => {
  it("lists threads in the order they were started, each note followed by its replies, numbered from 1", () => {
    const comments = [
      note("n2", "2026-01-02T00:00:00Z", { resolvedAt: "2026-01-05T00:00:00Z", resolvedById: "user_b", resolvedByEmail: "b@example.com" }),
      note("r1b", "2026-01-04T00:00:00Z", { parentId: "n1", authorId: "user_b", authorEmail: undefined }),
      note("n1", "2026-01-01T00:00:00Z", { atSec: 65.4, editedAt: "2026-01-03T00:00:00Z" }),
      note("r1a", "2026-01-03T00:00:00Z", { parentId: "n1" }),
      note("r2", "2026-01-02T12:00:00Z", { parentId: "n2" }),
      note("orphan", "2026-01-06T00:00:00Z", { parentId: "gone" }),
    ];
    const rows = commentRows(comments, formatTimestamp);
    assert.deepEqual(rows.map((r) => [r.thread, r.kind, r.text]), [
      ["1", "note", "Text of n1"],
      ["1", "reply", "Text of r1a"],
      ["1", "reply", "Text of r1b"],
      ["2", "note", "Text of n2"],
      ["2", "reply", "Text of r2"],
      ["3", "reply", "Text of orphan"],
    ]);
    assert.deepEqual(rows[0], { thread: "1", kind: "note", at: "1:05", author: "a@example.com", written: "2026-01-01T00:00:00Z", edited: "2026-01-03T00:00:00Z", status: "open", resolved_at: "", resolved_by: "", text: "Text of n1" });
    assert.equal(rows[2].author, "user_b", "an author without an email is named by id");
    assert.deepEqual([rows[4].status, rows[4].resolved_at, rows[4].resolved_by], ["resolved", "2026-01-05T00:00:00Z", "b@example.com"], "a reply carries its thread's status");
    assert.deepEqual(commentRows([], formatTimestamp), []);
  });

  it("makes a file a spreadsheet reads back, with formula-like text kept as text", () => {
    const text = '=HYPERLINK("x") says "hi",\nnext line';
    const csv = toCsv(COMMENT_CSV_COLUMNS, commentRows([note("n1", "2026-01-01T00:00:00Z", { text })], formatTimestamp));
    const table = parseCsv(csv);
    assert.deepEqual(table.columns, COMMENT_CSV_COLUMNS);
    assert.equal(table.rows[0].text, `'${text}`);
  });
});
