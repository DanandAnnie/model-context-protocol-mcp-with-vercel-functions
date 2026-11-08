// A Markdown script's headings as the names of the scenes they start.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { headingName, scenesFromText } from "../script-import";

describe("headingName", () => {
  it("keeps a heading's words and drops one that only numbers its part", () => {
    assert.equal(headingName("Kitchen"), "Kitchen");
    assert.equal(headingName("Scene 2: The kitchen"), "The kitchen");
    assert.equal(headingName("Part 3 – Pricing"), "Pricing");
    assert.equal(headingName("Scene 2"), undefined);
    assert.equal(headingName("Slide 4."), undefined);
    assert.equal(headingName("Chapter #3"), undefined);
    assert.equal(headingName("2"), undefined);
    assert.equal(headingName("1. Welcome"), "Welcome");
    // A decimal or range is part of the name, not a part's number.
    assert.equal(headingName("Section 2.1 Overview"), "Section 2.1 Overview");
    assert.equal(headingName("Step 1-2: Mix"), "Step 1-2: Mix");
    // Markup with no words names nothing, and a pause marker is left out.
    assert.equal(headingName("**"), undefined);
    assert.equal(headingName("---"), undefined);
    assert.equal(headingName("Kitchen [pause 2s]"), "Kitchen");
    // Words that only begin like a numbered part are kept whole.
    assert.equal(headingName("Scenery views"), "Scenery views");
    assert.equal(headingName("Part 3 of the tour"), "Part 3 of the tour");
    assert.equal(headingName("x".repeat(60)), "x".repeat(40));
    assert.equal(headingName(undefined), undefined);
  });
});

describe("scenesFromText names", () => {
  it("name each scene after the heading that starts it", () => {
    const doc = scenesFromText(["# Open house", "", "## Welcome", "Hello there.", "", "## Scene 2: The kitchen", "Redone last spring.", "", "---", "", "Call me."].join("\n"));
    assert.equal(doc.title, "Open house");
    assert.deepEqual(doc.scenes, ["Hello there.", "Redone last spring.", "Call me."]);
    assert.deepEqual(doc.names, ["Welcome", "The kitchen", undefined]);
  });
  it("leave a scene before any heading unnamed", () => {
    const doc = scenesFromText(["Hello there.", "", "## Kitchen", "Redone last spring."].join("\n"));
    assert.deepEqual(doc.names, [undefined, "Kitchen"]);
  });
  it("are left out when no heading names a scene, or in plain text", () => {
    assert.equal(scenesFromText("One.\n\n---\n\nTwo.").names, undefined);
    assert.equal(scenesFromText("## Scene 1\nOne.\n\n## Scene 2\nTwo.").names, undefined);
    assert.equal(scenesFromText("## Kitchen\nOne.\n\n## Garden\nTwo.", { markdown: false }).names, undefined);
  });
  it("are left out when a heading's section is joined to another", () => {
    // A section of only pauses too long for a silent scene (70 seconds) joins the one before it.
    const joined = scenesFromText(`## Kitchen\nRedone.\n\n## Pause\n${Array(7).fill("[pause 10s]").join(" ")}\n\n## Garden\nSouth facing.`);
    assert.equal(joined.scenes.length, 2);
    assert.equal(joined.names, undefined);
    // More sections than a video has scenes are packed together.
    const many = scenesFromText(Array.from({ length: 25 }, (_, i) => `## Room ${i + 1}\nWords for room ${i + 1}.`).join("\n\n"));
    assert.equal(many.scenes.length, 20);
    assert.equal(many.names, undefined);
  });
});
