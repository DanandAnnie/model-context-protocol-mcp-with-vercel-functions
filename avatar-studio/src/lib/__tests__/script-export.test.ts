// The script download, read back by the script import.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scriptFile, scriptFileName } from "../script-export";
import { decodeScript, scenesFromText } from "../script-import";

/** The scripts saved and read back as the editor does: the file's bytes, decoded, then imported as plain text. */
const roundTrip = (scripts: string[]) => scenesFromText(decodeScript(new TextEncoder().encode(scriptFile(scripts))), { markdown: false }).scenes;

describe("scriptFile", () => {
  it("puts the scenes apart on --- lines, which the import reads back scene for scene", () => {
    const scripts = ["Welcome home.\n\nThis is the kitchen.", "[pause 2s]", "Thanks for watching. Call 555-0100."];
    assert.equal(scriptFile(scripts), "﻿Welcome home.\n\nThis is the kitchen.\n\n---\n\n[pause 2s]\n\n---\n\nThanks for watching. Call 555-0100.\n");
    assert.deepEqual(roundTrip(scripts), scripts);
  });

  it("keeps a lone scene's paragraphs together as one scene", () => {
    assert.deepEqual(roundTrip(["One paragraph.\n\nAnother one."]), ["One paragraph.\n\nAnother one."]);
  });

  it("keeps a scene's own *** or --- line from starting a new scene", () => {
    assert.deepEqual(roundTrip(["Intro.\n\n***\n\nMore.", "B."]), ["Intro.\n\n***\n\nMore.", "B."]);
    assert.deepEqual(roundTrip(["A.", "* * *", "_ _ _"]), ["A.", "* * *", "_ _ _"]);
    // A break line touching others stays with its scene, its line breaks read as spaces as the import reads them.
    assert.deepEqual(roundTrip(["A.\n---\nB.", "C."]), ["A. --- B.", "C."]);
  });

  it("leaves out scenes without words, and trims the rest", () => {
    assert.deepEqual(roundTrip(["  First.  ", "", "   ", "Last.\r\n\r\nReally."]), ["First.", "Last.\n\nReally."]);
    assert.equal(scriptFile(["", "  "]), "");
  });

  it("keeps markup and text in any script, as plain text is taken as written", () => {
    assert.deepEqual(roundTrip(["# Not a heading", "Save *50%* today_now.", "Café — “quoted” 日本語"]), ["# Not a heading", "Save *50%* today_now.", "Café — “quoted” 日本語"]);
  });
});

describe("scriptFileName", () => {
  it("names the file after the title, without characters a file system refuses", () => {
    assert.equal(scriptFileName("Open house: 12 Elm St / Unit 3"), "Open house 12 Elm St Unit 3.txt");
    assert.equal(scriptFileName("  ..hidden.  "), "hidden.txt");
    assert.equal(scriptFileName("   "), "Script.txt");
    assert.equal(scriptFileName("Notes.txt"), "Notes.txt");
    assert.equal(scriptFileName("‮txt.exe"), "txt.exe.txt");
  });

  it("cuts a long title between characters as a person sees them", () => {
    assert.equal(scriptFileName("a".repeat(150)), `${"a".repeat(80)}.txt`);
    const name = scriptFileName(`${"x".repeat(79)}😀😀`);
    assert.equal(name, `${"x".repeat(79)}😀.txt`);
    assert.doesNotThrow(() => encodeURIComponent(name));
  });
});
