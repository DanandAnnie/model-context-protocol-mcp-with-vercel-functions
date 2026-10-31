// The transcripts panel's search and "left an email" box, shared with the CSV download so both hold the same visits.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_OPENING_KEY, OPENING_KEY_CHARS, conversationMatches, conversationTexts, mostAsked, openingKey } from "../transcripts";
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
    const c = visit(["Is the café open?", "Yes, until five."], { email: "Rowan@Example.com", name: "Rowan" });
    assert.deepEqual(conversationTexts(c), ["Rowan@Example.com", "Rowan", "Is the café open?", "Yes, until five."]);
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
    assert.equal(openingKey(visit(["ما هي ساعاتكم؟"])), openingKey(visit(["ما هي ساعاتكم"])));
    assert.equal(openingKey(visit(["Why‽"])), "why");
    // A long run of marks is set aside in one pass, not rescanned from each mark.
    const started = performance.now();
    for (let i = 0; i < 100; i++) assert.equal(openingKey(visit([`${"? ".repeat(999)}x`])), "? ".repeat(OPENING_KEY_CHARS / 2).trimEnd());
    assert.ok(performance.now() - started < 100, "openingKey stays linear in a run of marks");
    assert.equal(openingKey(visit(["?!…"])), null);
    assert.equal(openingKey(visit([])), null);
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
