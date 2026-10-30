// Reading a written conversation as one scene per turn.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_SPEAKERS, parseDialogue } from "../dialogue";
import { MAX_SCRIPT_CHARS } from "../script-import";
import { videoRequestSchema } from "../services";
import { MAX_SCENES } from "../types";

/** Whether the server would take the turns as a video's scenes. */
const renders = (turns: Array<{ text: string }>) =>
  videoRequestSchema.safeParse({ title: "Talk", avatarId: "stock_1", voiceId: "stock_voice_1", scenes: turns.map((t) => ({ script: t.text, background: { type: "color", value: "#fff" } })) }).success;

describe("parseDialogue", () => {
  it("makes one turn per line that starts with a name, and lists each speaker once", () => {
    const d = parseDialogue("Alex: Welcome back to the show.\nSam: Thanks for having me.\r\n\r\nAlex: Let's start with the market.\n");
    assert.deepEqual(d, {
      speakers: ["Alex", "Sam"],
      turns: [
        { speaker: "Alex", text: "Welcome back to the show." },
        { speaker: "Sam", text: "Thanks for having me." },
        { speaker: "Alex", text: "Let's start with the market." },
      ],
      skipped: 0,
      directions: 0,
      truncated: false,
    });
    assert.ok(renders(d.turns));
  });

  it("carries lines without a name on, joins a speaker's lines in a row, and leaves out what comes before the first name", () => {
    const d = parseDialogue(["The spring market, episode 12", "Recorded live", "", "ALEX: Prices are up.", "Inventory is down.", "ALEX: Here is why.", "SAM: Go on."].join("\n"));
    assert.deepEqual(d.turns, [
      { speaker: "ALEX", text: "Prices are up.\nInventory is down.\nHere is why." },
      { speaker: "SAM", text: "Go on." },
    ]);
    assert.deepEqual(d.speakers, ["ALEX", "SAM"]);
    assert.equal(d.skipped, 2);
  });

  it("reads the common ways of writing a name, and the same name in any case is one speaker", () => {
    const d = parseDialogue(["**Maya:** Hi.", "**Jon**: Hello.", "[Maya]: How are you?", "- jon: lower case is prose, not a name.", "> Jon: Fine.", "MAYA (V.O.): Good.", "Dr. Lee: Hello all.", "Ludwig van Beethoven: Da da da dum.", "アレックス：こんにちは"].join("\n"));
    // Numbered lines, a transcript's times, and single emphasis come off the name too.
    const transcript = parseDialogue(["1. Alex: Hi.", "2) Sam: Hello.", "[00:01:15] Alex: Welcome.", "00:02 *Sam:* Thanks."].join("\n"));
    assert.deepEqual(transcript.speakers, ["Alex", "Sam"]);
    assert.deepEqual(transcript.turns.map((t) => t.text), ["Hi.", "Hello.", "Welcome.", "Thanks."]);
    assert.deepEqual(d.speakers, ["Maya", "Jon", "Dr. Lee", "Ludwig van Beethoven", "アレックス"]);
    assert.deepEqual(
      d.turns.map((t) => [t.speaker, t.text]),
      [
        ["Maya", "Hi."],
        ["Jon", "Hello."],
        ["Maya", "How are you?\n- jon: lower case is prose, not a name."],
        ["Jon", "Fine."],
        ["Maya", "Good."],
        ["Dr. Lee", "Hello all."],
        ["Ludwig van Beethoven", "Da da da dum."],
        ["アレックス", "こんにちは"],
      ],
    );
  });

  it("never takes a link, a time, a ratio, or a line of prose for a name", () => {
    // Known limit: a line in title case before a colon ("Spring Market Update: April", "Tip: …") reads as a name, as it
    // would to a person skimming; the panel lists every speaker it finds, so a stray one is seen before scenes are made.
    assert.deepEqual(parseDialogue("Spring Market Update: April\nAlex: Hi.").speakers, ["Spring Market Update", "Alex"]);
    const d = parseDialogue(
      [
        "Host: Visit https://example.com/listings today.",
        "Doors open at 10:30 sharp.",
        "The ratio is 3:1 in our favour.",
        "Here's the thing: it sold in a week.",
        "Remember This Rule Always Now: five words is not a name.",
        "Note this.: a sentence is not a name.",
        "Guest: Wow.",
      ].join("\n"),
    );
    assert.deepEqual(d.speakers, ["Host", "Guest"]);
    assert.equal(d.turns[0].text.split("\n").length, 6);
    assert.deepEqual(d.turns[1], { speaker: "Guest", text: "Wow." });
  });

  it("leaves out lines of only a stage direction, and a name with nothing said", () => {
    const d = parseDialogue("Alex: Hi.\n(laughs)\nSam:\n(Both turn to the camera.)\nAlex: [pause 2s] Shall we?\nSam: (smiling) Let's.");
    // Sam's turn has nothing said, so Alex's two turns either side of it are one.
    assert.deepEqual(d.turns, [
      { speaker: "Alex", text: "Hi.\n[pause 2s] Shall we?" },
      { speaker: "Sam", text: "Let's." },
    ]);
    // A direction that opens a turn is not spoken either; one inside it is the writer's to keep or cut.
    assert.equal(d.directions, 3);
    assert.equal(parseDialogue("Alex: Thanks (laughs) for coming.").turns[0].text, "Thanks (laughs) for coming.");
    assert.equal(parseDialogue("Sam:\nAlex: Hi.").speakers.join(), "Alex");
  });

  it("keeps a long conversation within a video's scenes and characters, cutting between words", () => {
    const many = Array.from({ length: MAX_SCENES + 5 }, (_, i) => `${i % 2 ? "Sam" : "Alex"}: Line ${i + 1}.`).join("\n");
    const d = parseDialogue(many);
    assert.equal(d.turns.length, MAX_SCENES);
    assert.equal(d.truncated, true);
    assert.ok(renders(d.turns));

    const long = "word ".repeat(700).trim();
    const big = parseDialogue(`Alex: ${long}\nSam: ${long}\nAlex: More.`);
    assert.equal(big.truncated, true);
    assert.equal(big.turns.length, 2);
    assert.ok(big.turns.map((t) => t.text).join("\n\n").length <= MAX_SCRIPT_CHARS);
    assert.ok(big.turns[1].text.endsWith("word"));
    // A turn cut short ends after a sentence where it can, and is never a fragment, half a character, or half a marker.
    const sentences = parseDialogue(`Alex: ${"a".repeat(4900)}\nSam: That sold in a week. The next one took a month, and then ${"more words ".repeat(20)}`);
    assert.equal(sentences.turns[1].text, "That sold in a week.");
    assert.deepEqual(parseDialogue(`Alex: ${"a".repeat(4997)}\nSam: 😀😀😀😀`).turns.map((t) => t.speaker), ["Alex"]);
    assert.deepEqual(parseDialogue(`Alex: ${"a".repeat(4988)}\nSam: Hi [pause 2s] there, welcome.`).turns.length, 1);
    const marker = parseDialogue(`Alex: ${"a".repeat(4900)}\nSam: ${"Welcome to the open house tour ".repeat(2)}[pause 2s] ${"and more ".repeat(20)}`);
    assert.doesNotMatch(marker.turns[1].text, /\[pause[^\]]*$/);
    assert.ok(renders(big.turns));
    // A turn that leaves no room for the next leaves it out whole.
    const exact = parseDialogue(`Alex: ${"a".repeat(MAX_SCRIPT_CHARS)}\nSam: Hi.`);
    assert.deepEqual(exact.speakers, ["Alex"]);
    assert.equal(exact.truncated, true);
  });

  it("finds nothing in text without a name, and counts every speaker it finds", () => {
    assert.deepEqual(parseDialogue("Just a paragraph of script.\n\nAnother one."), { speakers: [], turns: [], skipped: 2, directions: 0, truncated: false });
    const crowd = parseDialogue(Array.from({ length: MAX_SPEAKERS + 1 }, (_, i) => `Speaker ${i + 1}: Hi.`).join("\n"));
    assert.equal(crowd.speakers.length, MAX_SPEAKERS + 1);
  });
});
