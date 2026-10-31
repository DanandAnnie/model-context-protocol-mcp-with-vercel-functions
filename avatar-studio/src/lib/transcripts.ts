import { foldTerm } from "./glossary";
import type { Conversation } from "./types";

/** Visits kept per presenter (the oldest are dropped past it); the transcripts panel lists them all. */
export const MAX_CONVERSATIONS_PER_AGENT = 100;

/** Longest transcript search a request may carry, in UTF-16 units as a text field counts them. */
export const MAX_TRANSCRIPT_QUERY = 200;

/** What a transcript search looks in: the visitor's email and name, then every message of the visit. */
export function conversationTexts(c: Conversation): Array<string | undefined> {
  return [c.visitor?.email, c.visitor?.name, ...c.messages.map((m) => m.content)];
}

/** Characters (code points) of a visit's first question that the "Most asked" chips compare; longer ones are grouped by these. */
export const OPENING_KEY_CHARS = 200;

/**
 * The question a visit opened with, as the "Most asked" chips group it: its first visitor message in one case and Unicode
 * form (NFKC, so "…" is "..." and "？" is "?"), runs of spaces and line breaks as one space, opening or closing marks
 * ("¿", "?!", "...", the Arabic "؟") set aside, a lone surrogate as U+FFFD (as a URL carries it), and only its first `OPENING_KEY_CHARS` characters, so the
 * key fits in a download link; `null` when the visit has none. Only the 40 newest messages of a visit are kept, so a
 * visit longer than that opens, here, with the oldest visitor message left.
 */
export function openingKey(c: Conversation): string | null {
  const asked = c.messages.find((m) => m.role === "user")?.content;
  if (!asked) return null;
  // The closing run is matched only from its start (the lookbehind), so a long run of marks is not scanned again from each.
  const folded = foldTerm(asked.replace(/\p{Cs}/gu, "\uFFFD"))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?<![\s.?!;¿¡؟‽。])[\s.?!;¿¡؟‽。]+$/u, "")
    .replace(/^[¿¡\s]+/u, "");
  const key = Array.from(folded).slice(0, OPENING_KEY_CHARS).join("").trimEnd();
  return key || null;
}

/** Longest opening question key a download may be narrowed by, in UTF-16 units: `OPENING_KEY_CHARS` code points of up to two each. */
export const MAX_OPENING_KEY = OPENING_KEY_CHARS * 2;

/**
 * Whether a visit passes the transcripts panel's search, its "left an email" box, and the "Most asked" question picked
 * (`opening`, an `openingKey`), compared as the panel compares them, so a download holds the same visits the panel shows.
 */
export function conversationMatches(c: Conversation, query: string, leadsOnly: boolean, opening?: string): boolean {
  if (leadsOnly && !c.visitor?.email) return false;
  if (opening && openingKey(c) !== opening) return false;
  const needle = foldTerm(query.trim());
  return !needle || conversationTexts(c).some((t) => !!t && foldTerm(t).includes(needle));
}

/** How many of the most asked opening questions the transcripts panel lists. */
export const TOP_QUESTIONS = 5;

/**
 * The questions visitors most often opened with, asked at least twice: grouped by `openingKey` (so a suggested question
 * tapped as a chip and the same words typed count together), each shown in its newest wording, most asked first and,
 * among equals, the one in the visit listed first. `visits` is newest first, as the panel lists them. Picking one narrows
 * the list to exactly the visits it counts.
 */
export function mostAsked(visits: Conversation[], limit = TOP_QUESTIONS): Array<{ question: string; key: string; count: number }> {
  const groups = new Map<string, { question: string; key: string; count: number; first: number }>();
  visits.forEach((c, i) => {
    const key = openingKey(c);
    if (!key) return;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { question: c.messages.find((m) => m.role === "user")!.content.replace(/\s+/g, " ").trim(), key, count: 1, first: i });
  });
  return [...groups.values()]
    .filter((g) => g.count >= 2)
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, limit)
    .map(({ question, key, count }) => ({ question, key, count }));
}
