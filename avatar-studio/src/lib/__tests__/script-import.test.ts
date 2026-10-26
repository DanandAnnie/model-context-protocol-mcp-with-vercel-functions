// Importing a text or Markdown document as scenes.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_SCRIPT_CHARS, decodeScript, scenesFromText } from "../script-import";
import { videoRequestSchema } from "../services";
import { MAX_SCENES } from "../types";

/** Whether the server would take the imported scenes as a video. */
const renders = (scenes: string[]) =>
  videoRequestSchema.safeParse({ title: "Imported", avatarId: "stock_1", voiceId: "stock_voice_1", scenes: scenes.map((script) => ({ script, background: { type: "color", value: "#fff" } })) }).success;

describe("scenesFromText", () => {
  it("gives a plain document one scene per paragraph, lines of a paragraph joined", () => {
    const doc = "﻿Welcome to the team.\r\nWe are glad you are here.\r\n\r\n\r\nYour first week starts Monday.\n";
    assert.deepEqual(scenesFromText(doc), { scenes: ["Welcome to the team. We are glad you are here.", "Your first week starts Monday."], truncated: false });
  });

  it("splits at breaks and headings, keeps a section's paragraphs together, and offers the title", () => {
    const doc = ["# Onboarding: week one", "", "## Hello", "Hi, I'm **Ava**.", "", "Here is the plan.", "---", "- Read the [handbook](https://x.test/h).", "- Meet your `buddy`.", "", "## Wrap up", "> See you *soon*!"].join("\n");
    assert.deepEqual(scenesFromText(doc), {
      title: "Onboarding: week one",
      scenes: ["Hi, I'm Ava.\n\nHere is the plan.", "Read the handbook. Meet your buddy.", "See you soon!"],
      truncated: false,
    });
    // A title alone does not divide the document: its paragraphs are still a scene each.
    assert.deepEqual(scenesFromText("# My talk\n\nFirst point.\n\nSecond point.\n\nThird point."), { title: "My talk", scenes: ["First point.", "Second point.", "Third point."], truncated: false });
    // Underlined headings and front matter; a line above --- is script, not a heading, so it is never lost.
    assert.deepEqual(scenesFromText("---\ntitle: Demo\nauthor: Me\n---\nWelcome\n=======\n\nHello there.\n\nThanks for watching\n-------\nThe plan.\n\n- Item one\n---\nAnother."), {
      title: "Welcome",
      scenes: ["Hello there.\n\nThanks for watching", "The plan.\n\nItem one", "Another."],
      truncated: false,
    });
    // Front matter needs YAML keys, and plain text has none.
    assert.deepEqual(scenesFromText("---\nNote: this is the intro.\n---\nScene two.").scenes, ["Note: this is the intro.", "Scene two."]);
    assert.deepEqual(scenesFromText("---\ntitle: Demo\n---\nScene two.", { markdown: false }).scenes, ["title: Demo", "Scene two."]);
    // Breaks spelled with spaces, comments, fences, link definitions, tables, and escapes.
    assert.deepEqual(scenesFromText("One.\n\n* * *\n\nTwo.\n- - -\nThree.").scenes, ["One.", "Two.", "Three."]);
    assert.deepEqual(
      scenesFromText("Read the [guide][g]. <!-- speaker note -->\n\n```js\nconsole.log(1)\n```\n\n| Plan | Price |\n|---|---:|\n| Pro | $10 |\n\nCost is 5 \\* 2, not \\*bold\\*.\n\n[g]: https://example.com/guide").scenes,
      ["Read the guide.", "console.log(1)", "Plan, Price. Pro, $10.", "Cost is 5 * 2, not *bold*."],
    );
    // Speaker labels are script, not link definitions; a real definition (a URL, maybe a title) is not spoken.
    assert.deepEqual(scenesFromText("[NARRATOR]: Welcome to the show.\n\n[HOST]: Thanks for having me.\n[1]: First, we begin.\n[docs]: https://x.test/d \"Docs\"").scenes, [
      "[NARRATOR]: Welcome to the show.",
      "[HOST]: Thanks for having me. [1]: First, we begin.",
    ]);
    // Code in a fence is read as written: its # is no heading or title, its --- no break, its ** no emphasis.
    assert.deepEqual(scenesFromText("```bash\n# install deps\nnpm i\n```\n\nFirst para.\n\nSecond para.\n\n~~~py\n---\ndef f(*args, **kwargs):\n    return __name__\n~~~"), {
      scenes: ["# install deps npm i", "First para.", "Second para.", "--- def f(*args, **kwargs): return __name__"],
      truncated: false,
    });
    // More Markdown: nested parentheses in a link, quoted lists, matched emphasis only, entities, strikethrough, footnotes, task boxes, escapes, bare rules.
    assert.deepEqual(
      scenesFromText("[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet)) today.\n\n> - quoted item\n\nPass _foo and bar* together, ~~old~~ new &amp; fine&nbsp;now[^1].\n\n- [ ] Call Sam\n- [x] Book room\n\nPrice \\$5 \\& more.\n\n=====\n\nAfter the rule.").scenes,
      ["Mercury today.\n\nquoted item\n\nPass _foo and bar* together, old new & fine now.\n\nCall Sam Book room\n\nPrice $5 & more.", "After the rule."],
    );
    assert.equal(scenesFromText("# Learn C#\n\nHi.").title, "Learn C#");
  });

  it("reads ordinary prose as written: comparisons, addresses, numbers, code, and plain-text files", () => {
    const prose = ["Margins grew from <1% to >5% this year.", "If x < 5 and y > 3 we stop. Keep a <b and c> d. If x<y and y>z we stop.", "Write to <help@example.com> or <https://example.com/help>.", "We sold\n100. That was the goal.", "Call `__init__` first, see <b>this</b>."].join("\n\n");
    assert.deepEqual(scenesFromText(prose).scenes, [
      "Margins grew from <1% to >5% this year.",
      "If x < 5 and y > 3 we stop. Keep a <b and c> d. If x<y and y>z we stop.",
      "Write to help@example.com or https://example.com/help.",
      "We sold 100. That was the goal.",
      "Call __init__ first, see this.",
    ]);
    // A list may follow a paragraph line directly; a wrapped number is still not a list.
    assert.deepEqual(scenesFromText("Here are the steps:\n- one\n- two\n* three\n\nSteps:\n1. Open\n2. Save").scenes, ["Here are the steps: one two three", "Steps: Open Save"]);
    // Plain text is not Markdown: nothing is taken out.
    assert.deepEqual(scenesFromText("# 1 rule\n\n- **Never** give up.", { markdown: false }).scenes, ["# 1 rule", "- **Never** give up."]);
    assert.deepEqual(scenesFromText("Use snake_case names. [pause 2s] Then go on.").scenes, ["Use snake_case names. [pause 2s] Then go on."]);
  });

  it("keeps a pause-only paragraph with its neighbour, so every scene has words", () => {
    assert.deepEqual(scenesFromText("Hello there.\n\n[pause 2s]\n\nWelcome back.").scenes, ["Hello there. [pause 2s]", "Welcome back."]);
    assert.deepEqual(scenesFromText("[pause]\n\nHello.").scenes, ["[pause] Hello."]);
    assert.deepEqual(scenesFromText("[pause 2s]"), { scenes: [], truncated: false });
    // Also a section of only a pause, between breaks.
    assert.deepEqual(scenesFromText("Hello.\n\n---\n\n[pause 3s]\n\n---\n\nBye.").scenes, ["Hello. [pause 3s]", "Bye."]);
    assert.deepEqual(scenesFromText("\n# Title only\n---\n\n"), { scenes: [], title: "Title only", truncated: false });
  });

  it("packs more paragraphs than a video has scenes, with nothing lost or reordered", () => {
    const many = Array.from({ length: 45 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
    const packed = scenesFromText(many);
    assert.ok(packed.scenes.length <= MAX_SCENES);
    assert.equal(packed.truncated, false);
    assert.equal(packed.scenes.join("\n\n"), many);
    assert.ok(renders(packed.scenes));
  });

  it("keeps a long document within what a video takes, cut at a sentence end, and says so", () => {
    const sentence = "This sentence is exactly forty-four chars. ";
    const para = sentence.repeat(16).trim();
    const doc = Array.from({ length: 10 }, () => para).join("\n\n");
    const r = scenesFromText(doc);
    assert.equal(r.truncated, true);
    assert.ok(r.scenes.join("\n\n").length <= MAX_SCRIPT_CHARS);
    assert.ok(r.scenes.join("\n\n").length > MAX_SCRIPT_CHARS - para.length, "the room left is used");
    assert.ok(r.scenes.every((s) => s.endsWith(".")));
    assert.ok(renders(r.scenes), "the server takes what was imported");
    // One paragraph longer than a whole video, and a pause marker is never cut in half.
    const words = Array.from({ length: 1200 }, (_, i) => (i % 50 === 49 ? "[pause 2s]" : "word")).join(" ");
    const one = scenesFromText(words);
    assert.equal(one.truncated, true);
    assert.ok(renders(one.scenes));
    assert.ok(!/\[pause$|^2s\]/.test(one.scenes[0]));
    // A cut never leaves a fragment: not half a pause marker, not a word or two.
    const nearlyFull = `${"a".repeat(4988)}.`;
    assert.deepEqual(scenesFromText(`${nearlyFull}\n\n[pause 2s] Hello world.`).scenes, [nearlyFull]);
    assert.deepEqual(scenesFromText(`${"b".repeat(4995)}.\n\nwords that will not fit here at all`).scenes, [`${"b".repeat(4995)}.`]);
    // A section's paragraph end or a quoted sentence end is a place to cut.
    const firstPart = `${"First part goes on. ".repeat(160).trim()}`;
    const section = scenesFromText(`${firstPart}\n\n${"Second part goes on and on ".repeat(120)}\n\n---\n\nEnd.`);
    assert.deepEqual(section.scenes, [firstPart]);
    assert.ok(scenesFromText(`${"He said \"stop.\" ".repeat(400)}`).scenes[0].endsWith('"stop."'));
    // A huge document is read as quickly as a short one, unclosed emphasis and links included.
    for (const doc of [`${"c".repeat(4995)}.\n\n${"long text ".repeat(90_000)}`, "a **b c **d e ".repeat(70_000), "__init and ".repeat(90_000), "[docs](https://x.y/a and ".repeat(40_000), "# \n".repeat(300_000), "[pause]\n\n".repeat(100_000)]) {
      const started = Date.now();
      const r = scenesFromText(doc);
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms for ${doc.slice(0, 30)}`);
      if (r.scenes.length) assert.ok(renders(r.scenes));
    }
    // An early short sentence does not use up the cut: an unpunctuated transcript is kept to the room left.
    const transcript = scenesFromText(`Hi. ${"word ".repeat(2000)}`).scenes;
    assert.ok(transcript[0].length > MAX_SCRIPT_CHARS - 50, String(transcript[0].length));
    // More sections than a video has scenes: the first ones are kept.
    const sections = scenesFromText(Array.from({ length: MAX_SCENES + 3 }, (_, i) => `Section ${i + 1}.`).join("\n\n---\n\n"));
    assert.equal(sections.scenes.length, MAX_SCENES);
    assert.equal(sections.scenes[0], "Section 1.");
    assert.equal(sections.truncated, true);
    assert.ok(renders(sections.scenes));
  });

  it("always gives scenes the server takes, whatever the document", () => {
    // A seeded mix of paragraphs, long runs, pauses, headings, breaks, and lists.
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    const pieces = ["Hello there.", "[pause 2s]", "# Part", "## Section", "---", "- item", "1. step", "word ".repeat(300), "x".repeat(900), "A sentence. ".repeat(80), "", ""];
    for (let n = 0; n < 300; n++) {
      const doc = Array.from({ length: 1 + rand(60) }, () => pieces[rand(pieces.length)]).join("\n");
      const r = scenesFromText(doc, { markdown: rand(4) > 0 });
      if (r.scenes.length) assert.ok(renders(r.scenes), doc.slice(0, 200));
      assert.ok(r.scenes.length <= MAX_SCENES && r.scenes.join("\n\n").length <= MAX_SCRIPT_CHARS);
    }
  });

  it("reads scripts as people write them: speaker replies, chat-wrapped Markdown, footnotes, CJK, Docs exports", () => {
    // Every line of a two-voice script, one-word replies included.
    assert.deepEqual(scenesFromText("# Episode 4\n\n[HOST]: Welcome back to the show.\n[GUEST]: Thanks.\n[HOST]: So, ready?\n[GUEST]: Absolutely.\n[HOST]: 10:30am, e.g. now.").scenes, [
      "[HOST]: Welcome back to the show. [GUEST]: Thanks. [HOST]: So, ready? [GUEST]: Absolutely. [HOST]: 10:30am, e.g. now.",
    ]);
    assert.deepEqual(scenesFromText("[HOST]: Great.\n\n[GUEST]: Agreed.").scenes, ["[HOST]: Great.", "[GUEST]: Agreed."]);
    assert.deepEqual(scenesFromText("Hi.\n\n[ref]: www.example.com\n[a]: ./notes.md\n[b]: /docs\n[c]: #top\n[d]: example.org/x \"T\"").scenes, ["Hi."]);
    // A script a chat assistant wrapped in a ```markdown fence is read as Markdown.
    assert.deepEqual(scenesFromText("```markdown\n# Scene 1\nHello **world**.\n\n# Scene 2\nBye.\n```"), { title: "Scene 1", scenes: ["Hello world.", "Bye."], truncated: false });
    // Inline code at the start of a line is no fence, nor is a fence that never closes.
    assert.deepEqual(scenesFromText("```npm i``` and go.\n\n## Next\nThen **this**.").scenes, ["npm i and go.", "Then this."]);
    assert.deepEqual(scenesFromText("```\n# Title\nHello *there*."), { title: "Title", scenes: ["Hello there."], truncated: false });
    // Footnote definitions (with their continuation) are not spoken.
    assert.deepEqual(scenesFromText("Sales grew 20%.[^1]\n\n[^1]: Source: annual report 2024.\n    More detail.\n\nThe end.").scenes, ["Sales grew 20%.", "The end."]);
    // Bold that holds an asterisk, and emphasis wrapped across lines.
    assert.deepEqual(scenesFromText("**Step 1: open *Settings***\n\n**5 * 3 = 15** is math.\n\nThis is **very\nimportant** now.").scenes, ["Step 1: open Settings", "5 * 3 = 15 is math.", "This is very important now."]);
    // Chinese and Japanese without spaces are cut at a full stop (or between characters), never dropped.
    for (const sentence of ["这是一个很长的句子，我们在这里讨论视频脚本的导入功能。", "これは動画の台本を読み込む機能についての長い文章です。"]) {
      const r = scenesFromText(sentence.repeat(220));
      assert.equal(r.truncated, true);
      assert.ok(r.scenes[0].length > MAX_SCRIPT_CHARS / 2 && r.scenes[0].endsWith(sentence.at(-1)!));
      assert.ok(renders(r.scenes));
    }
    assert.ok(scenesFromText("字".repeat(9000)).scenes[0].length > MAX_SCRIPT_CHARS - 10);
    // Google Docs image placeholders and their (huge) definitions are not spoken and do not use up the reading.
    const docs = `Hello there.\n\n![][image1]\n\n![](data:image/png;base64,${"A".repeat(24_000)})\n\nBye now.\n\n[image1]: <data:image/png;base64,${"B".repeat(30_000)}>`;
    assert.deepEqual(scenesFromText(docs), { scenes: ["Hello there.", "Bye now."], truncated: false });
    // A short sentence keeps its place when only a little room is left.
    const nearly = `${"Plenty of prose here. ".repeat(220).trim()}\n\nShort one. this sentence keeps going ${"and on ".repeat(60)}without ending`;
    assert.ok(scenesFromText(nearly).scenes.at(-1)!.endsWith("Short one."));
    // Many unclosed comments are read quickly.
    const started = Date.now();
    scenesFromText("<!-- ".repeat(200_000));
    assert.ok(Date.now() - started < 1500);
  });

  it("decodes a file as a word processor saved it: UTF-8, UTF-16 with its mark, or Windows-1252", () => {
    const text = "Café – “quoted” ✓";
    assert.equal(decodeScript(new TextEncoder().encode(text)), text);
    const le = new Uint8Array([0xff, 0xfe, ...Array.from(text).flatMap((c) => { const n = c.charCodeAt(0); return [n & 0xff, n >> 8]; })]);
    assert.equal(decodeScript(le), text);
    const be = new Uint8Array([0xfe, 0xff, ...Array.from(text).flatMap((c) => { const n = c.charCodeAt(0); return [n >> 8, n & 0xff]; })]);
    assert.equal(decodeScript(be), text);
    // "Café – “quoted”" in Windows-1252, which is not valid UTF-8.
    assert.equal(decodeScript(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x93, 0x71, 0x75, 0x6f, 0x74, 0x65, 0x64, 0x94])), "Café – “quoted”");
  });
});
