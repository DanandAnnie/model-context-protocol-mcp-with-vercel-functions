// A video's open comments as plain text, to paste into a chat or an email.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commentsAsText, repliesByThread } from "../comment-list";
import { formatTimestamp } from "../text";

type Note = { id: string; authorId: string; text: string; atSec?: number; authorEmail?: string; parentId?: string; createdAt: string };

describe("commentsAsText", () => {
  it("numbers the threads in the order given, with their moment, writer, and replies", () => {
    const threads: Note[] = [
      { id: "a", authorId: "u-ann", text: "Cut the pause here.", atSec: 68.4, authorEmail: "ann@example.com", createdAt: "2026-11-02T09:00:00Z" },
      { id: "b", authorId: "u-me", text: "Brighter title card.", createdAt: "2026-11-02T09:30:00Z" },
    ];
    const replies = repliesByThread<Note>([
      { id: "a1", authorId: "u-bob", parentId: "a", text: "On it.", authorEmail: "bob@example.com", createdAt: "2026-11-02T10:00:00Z" },
      { id: "a2", authorId: "u-me", parentId: "a", text: "Done.", createdAt: "2026-11-02T11:00:00Z" },
    ]);
    assert.equal(
      commentsAsText("Launch", threads, replies, formatTimestamp),
      ["Comments on “Launch” (2 comments)", "", "1. [1:08] Cut the pause here. (ann@example.com)", "   ↳ On it. (bob@example.com)", "   ↳ Done. (you)", "2. Brighter title card. (you)"].join("\n"),
    );
  });

  it("keeps a note's own lines under its first, past nine threads too", () => {
    const threads = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, authorId: "u-me", text: i === 9 ? "Two\r\n\r\nlines" : `Note ${i + 1}` }));
    const text = commentsAsText("Long", threads, new Map<string, typeof threads>(), formatTimestamp);
    assert.ok(text.startsWith("Comments on “Long” (10 comments)"));
    // Line breaks from any system come out as one; a blank line stays blank rather than a run of spaces.
    assert.ok(text.endsWith("10. Two\n\n    lines (you)"), JSON.stringify(text.slice(-40)));
    assert.ok(!text.includes("\r"));
    assert.equal(commentsAsText("One", [{ id: "x", authorId: "u-me", text: "Only" }], new Map(), formatTimestamp), "Comments on “One” (1 comment)\n\n1. Only (you)");
  });

  it("names a writer with no email as you only when it is the person copying", () => {
    const threads = [
      { id: "a", authorId: "u-me", text: "Mine." },
      { id: "b", authorId: "u-other", text: "Theirs." },
    ];
    const text = commentsAsText("Team", threads, new Map<string, typeof threads>(), formatTimestamp, "u-me");
    assert.ok(text.endsWith("1. Mine. (you)\n2. Theirs. (a teammate)"), text);
  });
});
