import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inRankOrder, inSortOrder, rankAssets } from "../asset-sort";

const items = [
  { id: "c", name: "Take 10", createdAt: "2026-10-30T10:00:02.000Z" },
  { id: "a", name: "take 2", createdAt: "2026-10-30T10:00:01.000Z" },
  { id: "b", name: "Éclair", createdAt: "2026-10-30T10:00:03.000Z" },
  { id: "d", name: "Take 2", createdAt: "2026-10-30T10:00:01.000Z" },
];
const order = (sort: Parameters<typeof rankAssets>[1]) => {
  const rank = rankAssets(items, sort, "en");
  return [...items].sort((x, y) => rank.get(x.id)! - rank.get(y.id)!).map((i) => i.id);
};

describe("rankAssets", () => {
  it("puts the newest first, the same moment broken by id", () => {
    assert.deepEqual(order("newest"), ["b", "c", "a", "d"]);
  });

  it("puts the oldest first, the same moment broken by id", () => {
    assert.deepEqual(order("oldest"), ["a", "d", "c", "b"]);
  });

  it("orders names as people read them: numbers by value, case and accents ignored", () => {
    // "Éclair" sorts with the Es; "take 2" and "Take 2" are equal names added at the same moment, so the id decides.
    assert.deepEqual(order("name"), ["b", "a", "d", "c"]);
  });

  it("breaks equal names newest first", () => {
    const twins = [
      { id: "z", name: "Intro", createdAt: "2026-10-30T09:00:00.000Z" },
      { id: "y", name: "intro", createdAt: "2026-10-30T11:00:00.000Z" },
    ];
    assert.deepEqual([...rankAssets(twins, "name", "en")], [["y", 0], ["z", 1]]);
  });

  it("follows the person's language for letters outside A to Z", () => {
    const words = [{ id: "1", name: "Ärta", createdAt: "2026-10-30T09:00:00.000Z" }, { id: "2", name: "Zebra", createdAt: "2026-10-30T09:00:01.000Z" }];
    assert.deepEqual([...rankAssets(words, "name", "en").keys()], ["1", "2"]);
    // In Swedish Ä is its own letter after Z.
    assert.deepEqual([...rankAssets(words, "name", "sv").keys()], ["2", "1"]);
  });

  it("puts what the ranking has not seen first and says when a list is out of order", () => {
    const rank = rankAssets(items, "name", "en");
    const added = { id: "n", name: "Aardvark", createdAt: "2026-10-30T10:00:04.000Z" };
    assert.deepEqual(inRankOrder([...items, added], rank).map((i) => i.id), ["n", "b", "a", "d", "c"]);
    assert.equal(inSortOrder(inRankOrder(items, rank), "name", "en"), true);
    // Renamed after it was placed: still where it was, but no longer in order.
    const renamed = inRankOrder(items, rank).map((i) => (i.id === "b" ? { ...i, name: "Zz" } : i));
    assert.equal(inSortOrder(renamed, "name", "en"), false);
    assert.equal(inSortOrder(renamed, "newest", "en"), false);
    assert.deepEqual(inRankOrder(items, undefined), items);
  });

  it("is empty for no assets", () => {
    assert.equal(rankAssets([], "name").size, 0);
  });
});
