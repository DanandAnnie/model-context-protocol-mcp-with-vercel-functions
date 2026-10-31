// The transcripts panel's search and "left an email" box, shared with the CSV download so both hold the same visits.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_OPENING_KEY, MAX_TRANSCRIPT_MESSAGES, OPENING_KEY_CHARS, columns, conversationMatches, conversationTexts, lastActivity, mostAsked, openingKey, transcriptText } from "../transcripts";
import { graphemes } from "../text";
import type { Conversation } from "../types";

const at = "2026-10-31T00:00:00.000Z";
const visit = (messages: string[], visitor?: Conversation["visitor"]): Conversation => ({
  id: "conv_x",
  ownerId: "u",
  agentId: "agent_x",
  messages: messages.map((content, i) => ({ role: i % 2 ? "assistant" : "user", content, at })),
  ...(visitor ? { visitor } : {}),
  startedAt: at,
  updatedAt: at,
});

describe("transcript search", () => {
  it("looks in the visitor's email and name and every message, in one case and Unicode form", () => {
    const c = visit(["Is the cafe\u0301 open?", "Yes, until five."], { email: "Rowan@Example.com", name: "Rowan" });
    assert.deepEqual(conversationTexts(c), ["Rowan@Example.com", "Rowan", "Is the cafe\u0301 open?", "Yes, until five."]);
    // The message spells "café" with a combining accent; the search, typed precomposed, still finds it, and the other way round.
    for (const q of ["rowan@example", "ROWAN", "caf\u00e9", "UNTIL FIVE", "  five  "]) assert.equal(conversationMatches(c, q, false), true, q);
    assert.equal(conversationMatches(visit(["Is the caf\u00e9 open?"]), "cafe\u0301", false), true);
    assert.equal(conversationMatches(c, "rentals", false), false);
    assert.equal(conversationMatches(c, "", false), true, "no search keeps every visit");
    assert.equal(conversationMatches(c, "   ", false), true);
  });

  it("with the box on keeps only visits that left an email, whatever they match", () => {
    const anon = visit(["Do you handle rentals?"]);
    assert.equal(conversationMatches(anon, "", true), false);
    assert.equal(conversationMatches(anon, "rentals", true), false);
    assert.equal(conversationMatches(visit(["Rentals?"], { email: "a@example.com" }), "rentals", true), true);
  });
});

describe("most asked opening questions", () => {
  it("count a visit's first question once, in one form, most asked first, and leave out ones asked once", () => {
    const v = (first: string, ...rest: string[]) => visit([first, "Sure.", ...rest]);
    const got = mostAsked([
      v("What are your hours?"),
      v("what are your  hours"),
      v("Do you take walk-ins?"),
      v("¿Tienen estacionamiento?"),
      v("Do you take walk-ins?", "What are your hours?"),
      v("Tienen estacionamiento"),
      v("WHAT ARE YOUR HOURS?!"),
      v("Only once?"),
    ]);
    // The newest wording stands for each; later questions in a visit are not opening ones.
    assert.deepEqual(got.map(({ question, count }) => ({ question, count })), [
      { question: "What are your hours?", count: 3 },
      { question: "Do you take walk-ins?", count: 2 },
      { question: "¿Tienen estacionamiento?", count: 2 },
    ]);
  });

  it("break ties by the newest asked, and keep to the limit", () => {
    const visits = ["B?", "A?", "B?", "A?", "C?", "C?"].map((q) => visit([q]));
    assert.deepEqual(mostAsked(visits, 2).map((g) => g.question), ["B?", "A?"]);
    assert.deepEqual(mostAsked([visit([]), visit(["   "])]), []);
  });
});

describe("picking a most asked question", () => {
  it("lists exactly the visits it counts, whatever their spacing, line breaks, marks, or Unicode form", () => {
    const visits = [
      "What are your hours…",
      "what are your  hours?",
      "What are\nyour hours﹖",
      "WHAT ARE YOUR HOURS",
      "Is the cafe\u0301 open?",
      "Is the caf\u00e9 open",
      // A later message that mentions the words is not an opening with them.
      "Hello",
    ].map((first, i) => visit(i === 6 ? [first, "Hi.", "What are your hours?"] : [first]));
    const top = mostAsked(visits);
    assert.deepEqual(top.map((t) => t.count), [4, 2]);
    for (const t of top) assert.equal(visits.filter((c) => conversationMatches(c, "", false, t.key)).length, t.count, t.question);
    assert.equal(openingKey(visit(["  ¿¡Hola!?  "])), "hola");
    assert.equal(openingKey(visit(["\u0645\u0627 \u0647\u064A \u0633\u0627\u0639\u0627\u062A\u0643\u0645\u061F"])), openingKey(visit(["\u0645\u0627 \u0647\u064A \u0633\u0627\u0639\u0627\u062A\u0643\u0645"])));
    assert.equal(openingKey(visit(["Why‽"])), "why");
    // A long run of marks is set aside in one pass, not rescanned from each mark.
    const started = performance.now();
    for (let i = 0; i < 100; i++) assert.equal(openingKey(visit([`${"? ".repeat(999)}x`])), "? ".repeat(OPENING_KEY_CHARS / 2).trimEnd());
    assert.ok(performance.now() - started < 100, "openingKey stays linear in a run of marks");
    assert.equal(openingKey(visit(["?!…"])), null);
    assert.equal(openingKey(visit([])), null);
  });

  it("leaves out visits followed up when only those not followed up are asked for", () => {
    const done = { ...visit(["Hours?"], { email: "a@example.com" }), followedUpAt: at };
    const open = visit(["Hours?"], { email: "b@example.com" });
    assert.deepEqual([done, open].filter((c) => conversationMatches(c, "", true, undefined, true)), [open]);
    assert.equal([done, open].filter((c) => conversationMatches(c, "", false)).length, 2);
  });

  it("is combined with the search and the email box", () => {
    const visits = [visit(["Hours?", "Nine to five."], { email: "a@example.com" }), visit(["Hours?", "Nine to five."])];
    const key = openingKey(visits[0])!;
    assert.equal(visits.filter((c) => conversationMatches(c, "", true, key)).length, 1);
    assert.equal(visits.filter((c) => conversationMatches(c, "nine", false, key)).length, 2);
    assert.equal(visits.filter((c) => conversationMatches(c, "ten", false, key)).length, 0);
  });
});

describe("opening question keys", () => {
  it("fit in a download link, however long the question or wide its characters once folded", () => {
    // "㌀" folds (NFKC) to four letters, so a 2000-character message would grow past 8000.
    const long = visit(["㌀".repeat(2000)]);
    const key = openingKey(long)!;
    assert.equal(Array.from(key).length, OPENING_KEY_CHARS);
    assert.ok(key.length <= MAX_OPENING_KEY);
    const emoji = openingKey(visit(["😀".repeat(500)]))!;
    assert.ok(emoji.length <= MAX_OPENING_KEY && /^(?:😀)+$/u.test(emoji));
    // Questions alike in their first 200 characters are counted as one.
    const a = "a ".repeat(150);
    assert.deepEqual(mostAsked([visit([`${a}one?`]), visit([`${a}two?`])]).map((t) => t.count), [2]);
  });

  it("carry a lone surrogate as a URL does, so a picked question still matches after the round trip", () => {
    const c = visit(["Hours \ud800 please?"]);
    const key = openingKey(c)!;
    assert.equal(key, "hours \ufffd please");
    const carried = new URLSearchParams(new URLSearchParams({ first: key }).toString()).get("first")!;
    assert.equal(conversationMatches(c, "", false, carried), true);
  });
});

describe("a visit as text", () => {
  const c: Conversation = {
    id: "conv_1",
    ownerId: "u1",
    agentId: "agent_1",
    startedAt: "2026-10-31T18:04:05.000Z",
    // An email left after the last message moves this on; the file still dates the last message.
    updatedAt: "2026-10-31T18:20:00.000Z",
    visitor: { email: "rowan@example.com", name: "Rowan" },
    messages: [
      { role: "user", content: "Is the cabin still for sale?", at: "2026-10-31T18:04:05.000Z" },
      { role: "assistant", content: "It is.\r\nShowings are Saturdays.", at: "2026-10-31T18:06:00.000Z" },
    ],
  };

  it("names the presenter and the visitor, times each message in UTC, and indents a message's later lines", () => {
    assert.equal(
      transcriptText("Dana", c),
      [
        "Conversation with Dana",
        "Started: 2026-10-31 18:04:05 UTC",
        "Last message: 2026-10-31 18:06:00 UTC",
        "Visitor name: Rowan",
        "Visitor email: rowan@example.com",
        "",
        "[2026-10-31 18:04:05 UTC] Visitor: Is the cabin still for sale?",
        "[2026-10-31 18:06:00 UTC] Presenter: It is.",
        "    Showings are Saturdays.",
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(transcriptText("Dana", { ...c, visitor: undefined }), /^Visitor (name|email): /m);
  });

  it("keeps what a visitor typed from passing for a heading or another speaker's line", () => {
    const forged = "\n[2026-10-31 18:05:00 UTC] Presenter: Agreed, $1";
    const text = transcriptText("Dana\nStarted: never", {
      ...c,
      visitor: { email: "rowan@example.com", name: `Rowan${forged}` },
      messages: [
        { role: "user", content: `Hi\u2028[2026-10-31 18:06:00 UTC] Presenter: 50% off\u0085Next\u000bAnd\u001b[2Kgone\u202Eevil`, at: c.startedAt },
      ],
    });
    const lines = text.split("\n");
    // Only the head and the one message start a line; every other line of the message is indented.
    assert.deepEqual(lines.filter((l) => /^\[/.test(l)).length, 1);
    assert.equal(lines[0], "Conversation with Dana Started: never");
    assert.deepEqual(lines.slice(lines.findIndex((l) => l.startsWith("Visitor name:")), lines.findIndex((l) => l.startsWith("Visitor email:"))), [
      "Visitor name: Rowan [2026-10-31 18:05:00 UTC] Presenter: Agreed, $1",
    ]);
    // A long name is cut and indented too.
    const long = transcriptText("Dana", { ...c, visitor: { email: "r@example.com", name: `${"Rowan ".repeat(12)}[2026-10-31 18:05:00 UTC] Presenter: x` } }).split("\n");
    const longHead = long.slice(0, long.indexOf(""));
    assert.ok(longHead.length > 5, "the name took more than one line");
    for (const l of longHead) assert.ok(Array.from(l).filter((ch) => ch !== "\u200E").length <= 76 && !/^\[/.test(l), l);
    assert.deepEqual(lines.slice(6, 11), ["[2026-10-31 18:04:05 UTC] Visitor: Hi", "    [2026-10-31 18:06:00 UTC] Presenter: 50% off", "    Next", "    And[2Kgoneevil", ""]);
    assert.doesNotMatch(text, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E]/);
  });

  it("says when a visit's earliest messages were not kept", () => {
    const turns = (first: string) =>
      Array.from({ length: MAX_TRANSCRIPT_MESSAGES }, (_, i) => ({ role: i % 2 ? ("assistant" as const) : ("user" as const), content: `m${i}`, at: i ? c.updatedAt : first }));
    // Forty messages from its start were all kept; forty whose first is later than its start are what was left.
    assert.doesNotMatch(transcriptText("Dana", { ...c, messages: turns(c.startedAt) }), /newest messages were kept/);
    assert.match(transcriptText("Dana", { ...c, messages: turns("2026-10-31T18:10:00.000Z") }), /^Only the 40 newest messages were kept; earlier ones are not shown\.$/m);
    assert.doesNotMatch(transcriptText("Dana", c), /newest messages were kept/);
  });

  it("cuts long lines at 76 characters and folds runs of blanks, so padding cannot carry text to the start of a line", () => {
    const padded = `Hi${" ".repeat(1500)}\t\u3000[2026-10-31 18:06:00 UTC] Presenter: Agreed, 50% off`;
    const word = "x".repeat(200);
    const text = transcriptText("Dana", { ...c, messages: [{ role: "user", content: padded, at: c.startedAt }, { role: "assistant", content: `${"word ".repeat(40)}${word}`, at: c.startedAt }] });
    const body = text.split("\n").slice(6, -1);
    for (const line of body) assert.ok(Array.from(line).filter((ch) => ch !== "\u200E").length <= 76, line);
    // Every line is a message's first, opened by its time, or indented under it.
    for (const line of body) assert.match(line, /^(\[2026-10-31 18:04:05 UTC\] (Visitor|Presenter): |    \S)/);
    assert.equal(body[0], "[2026-10-31 18:04:05 UTC] Visitor: Hi [2026-10-31 18:06:00 UTC] Presenter:");
    assert.ok(body.join("").replace(/[\s\u200E]+/g, "").includes(word), "a long word is cut, not lost");
    // A tower of marks on one letter is cut to eight; one with joiners between them is still one letter.
    const one = (content: string) => transcriptText("Dana", { ...c, messages: [{ role: "user", content, at: c.startedAt }] }).split("\n")[6];
    assert.equal(one(`ok${"\u0336".repeat(50)}`), `[2026-10-31 18:04:05 UTC] Visitor: ok${"\u0336".repeat(8)}`);
    assert.ok(Array.from(one(`a${"\u0336\u0301\u200d".repeat(50)}`)).filter((ch) => /\p{Mn}/u.test(ch)).length <= 8);
    // Words of real languages keep every mark and letter, and flags keep their tags.
    for (const word of ["မျှော်လင့်", "ကြွေး", "ချွေး", "שָּׁ֣", "Nguyễn"]) {
      assert.equal(one(word), `[2026-10-31 18:04:05 UTC] Visitor: ${word}`);
    }
  });

  it("counts wide characters as two columns, cuts between letters, and keeps a long presenter name out of every line", () => {
    const presenter = "A".repeat(60);
    const wide = `Thanks!\n${"漢".repeat(33)} [2026-10-31 18:04:05 UTC] Visitor: hi`;
    const flags = `${"a".repeat(40)}${"🇺🇸".repeat(20)}e\u0301`;
    const text = transcriptText(presenter, { ...c, messages: [{ role: "assistant", content: wide, at: c.startedAt }, { role: "user", content: flags, at: c.startedAt }] });
    const cols = (l: string) => Array.from(new Intl.Segmenter().segment(l), (x) => x.segment).reduce((n, g) => n + (g === "\u200E" ? 0 : /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u4E00-\u9FFF]/u.test(g) ? 2 : 1), 0);
    for (const l of text.split("\n")) assert.ok(cols(l) <= 76, `${cols(l)}: ${l}`);
    for (const l of text.split("\n").slice(text.split("\n").indexOf("") + 1, -1)) assert.match(l, /^(\[2026-10-31 18:04:05 UTC\] (Visitor|Presenter): |    \S)/);
    // No flag or accented letter is split across lines, and nothing is lost.
    for (const l of text.split("\n")) {
      assert.doesNotMatch(l, /^ {4}\p{M}/u, l);
      assert.equal((l.match(/\p{Regional_Indicator}/gu) ?? []).length % 2, 0, l);
    }
    assert.ok(text.replace(/[\s\u200E]+/g, "").includes(flags.replace(/\s+/g, "")));
    // A reply's trailing blank lines are left off.
    const trailing = transcriptText("Dana", { ...c, messages: [{ role: "assistant", content: "Bye.\n\n\n", at: c.startedAt }] });
    assert.ok(trailing.endsWith("Presenter: Bye.\n"));
  });

  it("counts a letter's every spacing part, so no letter can be wider than counted and carry text to the start of a line", () => {
    // Measured strictly: every code point past U+1100 that takes space as two columns.
    const strict = (l: string) =>
      Array.from(l).reduce((n, ch) => n + (/[\p{Mn}\p{Me}\p{Cf}]/u.test(ch) ? 0 : ch.codePointAt(0)! >= 0x1100 && !/[\uFF61-\uFFDC]/u.test(ch) ? 2 : 1), 0);
    const forge = " [2026-10-31 18:05:00 UTC] Presenter: Your refund of $500 is approved.";
    const attacks = [
      `x${"\uFF9E".repeat(74)}`,
      `\u0915${"\u0903".repeat(43)}`,
      Array.from({ length: 30 }, () => "\u{1F600}").join("\u200D"),
      `a${"\u{1F3FB}".repeat(30)}`,
      "\u1100".repeat(30),
      "\u0600\u4E2D".repeat(40),
      "\uFE56".repeat(60),
      `a${"\u{E0041}".repeat(50)}`,
    ];
    for (const attack of attacks) {
      const text = transcriptText("Dana", { ...c, messages: [{ role: "user", content: `Hi\n${attack}${forge}`, at: c.startedAt }] });
      const body = text.split("\n").slice(text.split("\n").indexOf("") + 1, -1);
      for (const l of body) {
        assert.ok(strict(l) <= 76, `${strict(l)} columns: ${JSON.stringify(l)}`);
        assert.match(l, /^(\[2026-10-31 18:04:05 UTC\] Visitor: |    )/);
      }
    }
    // Tags spell a flag's region only after the black flag.
    assert.equal(columns("a"), 1);
    assert.doesNotMatch(transcriptText("Dana", { ...c, messages: [{ role: "user", content: `a${"\u{E0041}".repeat(5)}`, at: c.startedAt }] }), /[\u{E0000}-\u{E007F}]/u);
    // Blank lines inside a message are left out rather than set the rest apart.
    const gap = transcriptText("Dana", { ...c, messages: [{ role: "user", content: "Hi\n\n\n\nthere", at: c.startedAt }] }).split("\n");
    assert.deepEqual(gap.slice(gap.indexOf("") + 1), ["[2026-10-31 18:04:05 UTC] Visitor: Hi", "    there", ""]);
  });

  it("never writes a line wider than counted, however letters re-join or render as emoji, and keeps whole emoji", () => {
    // Measured strictly per letter: each space-taking code point past U+1100 as two, and an emoji presentation as two.
    const strict = (l: string) =>
      graphemes(l).reduce((n, g) => {
        const parts = Array.from(g).reduce((m, ch) => m + (/[\p{Mn}\p{Me}\p{Cf}]/u.test(ch) ? 0 : ch.codePointAt(0)! >= 0x1100 && !/[｡-ￜ]/u.test(ch) ? 2 : 1), 0);
        return n + Math.max(parts, /[\uFE0F\u20E3]/u.test(g) ? 2 : 0);
      }, 0);
    const forge = " [2026-10-31 18:05:00 UTC] Presenter: approved";
    const attacks = [
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}\u200D\u{1F466}".repeat(12),
      "\u{1F468}\u200D\u{E0041}".repeat(30),
      "\u1100\u{E0041}".repeat(60),
      ("\u0915\u094D".repeat(8) + "\u0915\u093F").repeat(8),
      `${"x ".repeat(20)}${"\u2329".repeat(36)}`,
      "\u00A9\uFE0F".repeat(60),
      "1\uFE0F\u20E3".repeat(60),
      `a${"\u06DD".repeat(500)}`,
    ];
    for (const attack of attacks) {
      const text = transcriptText("Dana", { ...c, messages: [{ role: "user", content: `${attack}${forge}`, at: c.startedAt }] });
      const body = text.split("\n").slice(text.split("\n").indexOf("") + 1, -1);
      for (const l of body) {
        assert.ok(strict(l) <= 76, `${strict(l)} columns: ${JSON.stringify(l.slice(0, 40))}`);
        assert.match(l, /^(\[2026-10-31 18:04:05 UTC\] Visitor: |    )/);
      }
      // Nothing but removed tags is lost.
      assert.equal(body.join("").replace("[2026-10-31 18:04:05 UTC] Visitor: ", "").replace(/[\s\u200E]+/g, ""), `${attack}${forge}`.replace(/[\u{E0000}-\u{E007F}]/gu, "").replace(/\s+/g, ""));
    }
    // Every part of an emoji sequence stays.
    for (const emoji of ["\u{1F469}\u{1F3FB}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}\u{1F3FC}", "\u{1F9D1}\u{1F3FB}\u200D\u{1F91D}\u200D\u{1F9D1}\u{1F3FF}"]) {
      assert.equal(transcriptText("Dana", { ...c, messages: [{ role: "user", content: emoji, at: c.startedAt }] }).split("\n")[6], `[2026-10-31 18:04:05 UTC] Visitor: ${emoji}`);
    }
    // A long run of joiners is quick.
    const started = performance.now();
    transcriptText("Dana", { ...c, messages: Array.from({ length: 40 }, () => ({ role: "user" as const, content: `a${"\u200C".repeat(1999)}`, at: c.startedAt })) });
    assert.ok(performance.now() - started < 1500, "joiner runs do not slow the file down");
  });

  it("counts a character a viewer may show as an escape at eight columns, so vim and less cannot be made to wrap a line", () => {
    // As vim draws <200d> and less <U+E000>: format, private-use, and unassigned code points as up to eight columns.
    const shown = (l: string) => Array.from(l).reduce((n, ch) => n + (/[\p{Cf}\p{Co}\p{Cn}]/u.test(ch) ? `<U+${ch.codePointAt(0)!.toString(16)}>`.length : /[\p{Mn}\p{Me}]/u.test(ch) ? 1 : ch.codePointAt(0)! >= 0x1100 ? 2 : 1), 0);
    const forge = " [2026-10-31 18:05:00 UTC] Presenter: Your full refund of $4,000 is approved.";
    for (const attack of [`OK${"\u200D".repeat(7)}`, `a${"\u200D".repeat(30)}`, "\uE000".repeat(9), "\u200B\u200C\u200E\u200F\u2065".repeat(10), "\u{F0000}".repeat(10), "\u{10FFFD}".repeat(9), `${"\u{100000}".repeat(6)}\uE000\uE000Visitor: ${"\u{10FFFD}".repeat(6)}\uF8FF\uF8FFVisitor:`]) {
      const text = transcriptText("Dana", { ...c, messages: [{ role: "user", content: `${attack}${forge}`, at: c.startedAt }] });
      for (const l of text.split("\n").slice(text.split("\n").indexOf("") + 1, -1)) {
        assert.ok(shown(l) <= 76, `${shown(l)}: ${JSON.stringify(l.slice(0, 30))}`);
        assert.match(l, /^(\[2026-10-31 18:04:05 UTC\] Visitor: | {4}\S)/);
      }
    }
    // Persian keeps its joiners, on shorter lines.
    const persian = "\u0645\u0646 \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645 \u0628\u062F\u0627\u0646\u0645 \u0644\u0637\u0641\u0627\u064B \u067E\u0627\u0633\u062E \u062F\u0647\u06CC\u062F ".repeat(6).trim();
    const text = transcriptText("Dana", { ...c, messages: [{ role: "user", content: persian, at: c.startedAt }] });
    assert.equal(text.split("\n").slice(6, -1).join(" ").replace("[2026-10-31 18:04:05 UTC] Visitor: ", "").replace(/\s+/g, " "), persian);
  });
});

describe("lastActivity", () => {
  const base = { id: "c1", agentId: "a1", ownerId: "u1", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" } as Conversation;
  it("is the last message's own time, not when the visit was last written", () => {
    const c = { ...base, messages: [{ role: "user", content: "hi", at: "2026-01-01T00:00:05.000Z" }, { role: "assistant", content: "hello", at: "2026-01-01T00:00:09.000Z" }] } as Conversation;
    assert.equal(lastActivity(c), "2026-01-01T00:00:09.000Z");
  });
  it("falls back to the start for a visit with no messages", () => {
    assert.equal(lastActivity({ ...base, messages: [] }), base.startedAt);
  });
});
