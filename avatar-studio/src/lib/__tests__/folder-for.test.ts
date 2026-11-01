// The folder a name typed in the library's bulk "Move to folder" means: an existing folder when only case or spacing
// differ, so a typo in case does not start a near twin of a folder, else the name as typed.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { folderFor } from "../client";

const folders = ["Launch", "Q4 Campaign", "Ünïcode"];

describe("folderFor", () => {
  it("joins an existing folder that differs only in case or spacing", () => {
    assert.equal(folderFor("launch", folders), "Launch");
    assert.equal(folderFor("  LAUNCH  ", folders), "Launch");
    assert.equal(folderFor("q4   campaign", folders), "Q4 Campaign");
    assert.equal(folderFor("ÜNÏCODE", folders), "Ünïcode");
  });

  it("keeps a new name as typed, trimmed, as the server and the video page store it", () => {
    assert.equal(folderFor("Launch 2", folders), "Launch 2");
    assert.equal(folderFor("  New  idea ", folders), "New  idea");
    assert.equal(folderFor("Launch", []), "Launch");
  });

  it("prefers the folder of exactly that name when twins differ only in case or spacing", () => {
    // Sorted as the library sends them: capitals (and a space) first.
    const twins = ["Launch", "Q4  Campaign", "Q4 Campaign", "launch"];
    assert.equal(folderFor("launch", twins), "launch");
    assert.equal(folderFor("Launch", twins), "Launch");
    assert.equal(folderFor(" Q4 Campaign ", twins), "Q4 Campaign");
    assert.equal(folderFor("LAUNCH", twins), "Launch", "no exact match: the first twin");
  });

  it("means Unfiled for an empty or blank name", () => {
    assert.equal(folderFor("", folders), "");
    assert.equal(folderFor("   ", folders), "");
  });

  it("lowercases the same in every locale", () => {
    assert.equal(folderFor("INFO", ["info"]), "info");
    assert.equal(folderFor("info", ["INFO"]), "INFO");
  });
});
