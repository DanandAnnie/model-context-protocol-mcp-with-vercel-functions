// Importing a text or Markdown document as scenes.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_SCENE_CHARS, scenesFromText } from "../script-import";
import { MAX_SCENES } from "../types";

describe("scenesFromText", () => {
  it("gives a plain document one scene per paragraph, lines of a paragraph joined", () => {
    const doc = "﻿Welcome to the team.\r\nWe are glad you are here.\r\n\r\n\r\nYour first week starts Monday.\n";
    assert.deepEqual(scenesFromText(doc), { scenes: ["Welcome to the team. We are glad you are here.", "Your first week starts Monday."], truncated: false });
  });

  it("splits at breaks and headings, keeps a section's paragraphs together, and offers the first title", () => {
    const doc = ["# Onboarding: week one", "", "## Hello", "Hi, I'm **Ava**.", "", "Here is the plan.", "---", "- Read the [handbook](https://x.test/h).", "- Meet your `buddy`.", "", "## Wrap up", "> See you *soon*!"].join("\n");
    assert.deepEqual(scenesFromText(doc), {
      title: "Onboarding: week one",
      scenes: ["Hi, I'm Ava.\n\nHere is the plan.", "Read the handbook. Meet your buddy.", "See you soon!"],
      truncated: false,
    });
    // Words joined by underscores, and a pause marker, are left as written.
    assert.deepEqual(scenesFromText("Use snake_case names. [pause 2s] Then go on.").scenes, ["Use snake_case names. [pause 2s] Then go on."]);
  });

  it("packs more paragraphs than a video has scenes, and cuts a long one at a sentence end", () => {
    const many = Array.from({ length: 45 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
    const packed = scenesFromText(many);
    assert.equal(packed.scenes.length <= MAX_SCENES, true);
    assert.equal(packed.truncated, false);
    assert.equal(packed.scenes.join("\n\n"), many, "nothing is lost or reordered");

    const sentence = "This sentence is exactly forty-four chars. ";
    const long = sentence.repeat(Math.ceil((MAX_SCENE_CHARS * 1.5) / sentence.length)).trim();
    const cut = scenesFromText(long).scenes;
    assert.equal(cut.length, 2);
    assert.ok(cut.every((s) => s.length <= MAX_SCENE_CHARS && s.endsWith(".")));
    assert.equal(cut.join(" "), long);
  });

  it("keeps the first scenes and says so when sections overflow, and finds nothing in an empty document", () => {
    const sections = Array.from({ length: MAX_SCENES + 3 }, (_, i) => `Section ${i + 1}.`).join("\n---\n");
    const r = scenesFromText(sections);
    assert.equal(r.scenes.length, MAX_SCENES);
    assert.equal(r.scenes[0], "Section 1.");
    assert.equal(r.truncated, true);
    assert.deepEqual(scenesFromText("\n# Title only\n---\n\n"), { scenes: [], title: "Title only", truncated: false });
  });
});
