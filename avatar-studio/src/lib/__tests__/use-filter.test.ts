// The Avatars and Voices pages' "Use in videos" filter, by how many videos need each presenter or voice.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePresenterSort, passesUse, shownPresenterSort, sortPresenters } from "../client";

describe("passesUse", () => {
  const counts = { anna: 2, ben: 0, constructor: 1 };
  it("lets everything through when either will do", () => {
    assert.equal(passesUse(counts, "anna", "all"), true);
    assert.equal(passesUse(undefined, "anna", "all"), true);
  });

  it("keeps only the ones some video needs, or only those none does", () => {
    assert.equal(passesUse(counts, "anna", "used"), true);
    assert.equal(passesUse(counts, "anna", "unused"), false);
    assert.equal(passesUse(counts, "ben", "used"), false);
    assert.equal(passesUse(counts, "ben", "unused"), true);
    assert.equal(passesUse(counts, "nobody", "unused"), true);
    // Counts not read yet list nothing as either.
    assert.equal(passesUse(undefined, "anna", "unused"), false);
    assert.equal(passesUse(undefined, "anna", "used"), false);
  });

  it("reads an id's own count only", () => {
    assert.equal(passesUse(counts, "constructor", "used"), true);
    assert.equal(passesUse({ anna: 1 }, "toString", "used"), false);
    assert.equal(passesUse({ anna: 1 }, "__proto__", "unused"), true);
  });
});

describe("sortPresenters", () => {
  const items = [
    { id: "c", name: "ava 10" },
    { id: "a", name: "Ben" },
    { id: "b", name: "Ava 2" },
    { id: "d", name: "Cleo" },
  ];
  const inVideos = new Map([["a", 3], ["d", 3], ["b", 1]]);
  it("keeps the listed order by default, and the same array", () => {
    assert.equal(sortPresenters(items, "default", inVideos), items);
  });
  it("puts the most used first, ties and the uncounted in their listed order", () => {
    assert.deepEqual(sortPresenters(items, "used", inVideos).map((x) => x.id), ["a", "d", "b", "c"]);
    assert.deepEqual(items.map((x) => x.id), ["c", "a", "b", "d"]);
  });
  it("sorts by name ignoring case, reading numbers as numbers", () => {
    assert.deepEqual(sortPresenters(items, "name", inVideos).map((x) => x.name), ["Ava 2", "ava 10", "Ben", "Cleo"]);
  });
});

describe("parsePresenterSort", () => {
  it("reads back a stored sort, and anything else as the default", () => {
    assert.equal(parsePresenterSort("used"), "used");
    assert.equal(parsePresenterSort("name"), "name");
    assert.equal(parsePresenterSort("default"), "default");
    for (const raw of [null, undefined, "", "Name", "newest"]) assert.equal(parsePresenterSort(raw), "default");
  });
});

describe("shownPresenterSort", () => {
  it("shows a remembered Most used only once the counts are read", () => {
    assert.equal(shownPresenterSort("used", false), "default");
    assert.equal(shownPresenterSort("used", true), "used");
    assert.equal(shownPresenterSort("name", false), "name");
    assert.equal(shownPresenterSort("default", true), "default");
  });
});
