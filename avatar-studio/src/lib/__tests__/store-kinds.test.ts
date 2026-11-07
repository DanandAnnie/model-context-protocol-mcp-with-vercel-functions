// Every kind of record the store keeps must be allowed by the Supabase table's check constraint, or saving one fails
// in production only (the memory store takes any kind). Run with: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(__dirname, "..", "..", "..");

describe("store kinds", () => {
  it("are the kinds the Supabase schema allows, no more and no fewer", () => {
    const ts = readFileSync(join(root, "src/lib/store/index.ts"), "utf8");
    const union = /export type ItemKind = ([^;]+);/.exec(ts)?.[1] ?? "";
    const kinds = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
    const sql = readFileSync(join(root, "supabase/schema.sql"), "utf8");
    const list = /studio_items_kind_check check \(kind in \(([^)]+)\)\)/.exec(sql)?.[1] ?? "";
    const allowed = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    assert.ok(kinds.length > 30, "the kinds were read");
    assert.deepEqual(allowed, kinds);
  });
});
