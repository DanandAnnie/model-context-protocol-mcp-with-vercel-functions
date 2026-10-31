// The transcripts panel's search and "left an email" box, shared with the CSV download so both hold the same visits.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conversationMatches, conversationTexts } from "../transcripts";
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
