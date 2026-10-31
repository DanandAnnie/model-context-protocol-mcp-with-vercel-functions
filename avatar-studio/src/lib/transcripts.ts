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

/**
 * Whether a visit passes the transcripts panel's search and its "left an email" box, compared in one case and Unicode
 * form as the panel's search is, so a download holds the same visits the panel shows.
 */
export function conversationMatches(c: Conversation, query: string, leadsOnly: boolean): boolean {
  if (leadsOnly && !c.visitor?.email) return false;
  const needle = foldTerm(query.trim());
  return !needle || conversationTexts(c).some((t) => !!t && foldTerm(t).includes(needle));
}
