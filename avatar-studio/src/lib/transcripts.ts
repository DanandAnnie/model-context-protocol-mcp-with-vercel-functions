import { foldTerm } from "./glossary";
import { graphemes, wellFormed } from "./text";
import type { Conversation } from "./types";

/**
 * When a visit last had a message: what the transcripts list orders by (newest first) and the oldest are pruned by. It is
 * not `updatedAt`, which every write moves (it is the row's version), so leaving an email or a follow-up mark does not
 * move a visit.
 */
export function lastActivity(c: Conversation): string {
  return c.messages.at(-1)?.at ?? c.startedAt;
}

/** Visits kept per presenter (the oldest are dropped past it); the transcripts panel lists them all. */
export const MAX_CONVERSATIONS_PER_AGENT = 100;

/** Messages kept per visit, the newest; a longer visit loses its oldest. */
export const MAX_TRANSCRIPT_MESSAGES = 40;

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
 * Whether a visit passes the transcripts panel's search, its "left an email" and "not followed up" boxes, and the "Most
 * asked" question picked (`opening`, an `openingKey`), compared as the panel compares them, so a download holds the same visits the panel shows.
 */
export function conversationMatches(c: Conversation, query: string, leadsOnly: boolean, opening?: string, pendingOnly = false): boolean {
  if (leadsOnly && !c.visitor?.email) return false;
  if (pendingOnly && c.followedUpAt) return false;
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

/** A UTC time as "2026-10-31 18:04:05 UTC", the same for every reader of a file. */
function utc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/**
 * Control characters, the controls that embed, override, or isolate a run of text in another direction, and invisible
 * operators, which have no place in a plain-text line: written as is, they could fake a line, reorder it, or hide part of
 * it. Marks text needs (the joiners, the direction marks, a zero-width space, flag tags) stay.
 */
const UNPRINTABLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u180E\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;
/** Every way a line can end, as editors and terminals count them. */
const LINE_BREAK = /\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/;
/** Runs of spaces and tabs, which could push text to where a viewer wraps a line; each becomes one space. */
const BLANKS = /[\t\p{Zs}]+/gu;
/**
 * Code points at or past U+1100 that are one column wide: Latin and Greek extensions, punctuation and symbols (but not
 * the angle brackets U+2329/232A or the digrams U+268A-268F, which are wide), Latin, Hebrew, and Arabic presentation
 * forms, and halfwidth forms. Every other code point from U+1100 on counts as two (emoji, CJK, Hangul, and anything not
 * known to be narrow), so a line can only be counted wider than it is.
 */
const NARROW_HIGH = /[\u1E00-\u1FFF\u2000-\u2328\u232B-\u2689\u2690-\u2E39\u2E3C-\u2E7F\uFB00-\uFDFC\uFDFE\uFDFF\uFE70-\uFEFF\uFF61-\uFFDC\uFFE8-\uFFEE]/u;
/** Drawn several columns wide by most fonts: the long dashes and the Arabic ligatures U+FDFA, U+FDFB, and U+FDFD. */
const EXTRA_WIDE = /[\u2E3A\u2E3B\uFDFA\uFDFB\uFDFD]/u;
/**
 * Characters a viewer may draw as an escape such as `<200d>` or `<U+10FFFD>` instead of a glyph:
 * format characters (joiners and direction marks among them), private-use, unassigned, and surrogate code points.
 */
const MAY_ESCAPE = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u;
/** Columns an escape takes: `<U+` and `>` around the code point's hex digits, and never under eight. */
function escapeColumns(cp: number): number {
  return Math.max(8, cp.toString(16).length + 4);
}
/** Nonspacing marks one letter may carry; past this they draw over the lines above and below, and are dropped. */
const MAX_MARKS = 8;
/** Widest line the file writes, in screen columns, so a viewer at least this wide never wraps one. */
const LINE_WIDTH = 76;
const INDENT = "    ";

/**
 * Screen columns one code point takes, at most, in any viewer: one that may be drawn as an escape counts its width, a mark
 * one (some viewers do not know newer marks), a spacing mark two, and a long dash or ligature three.
 */
function codePointColumns(ch: string): number {
  if (MAY_ESCAPE.test(ch)) return escapeColumns(ch.codePointAt(0)!);
  if (/[\p{Mn}\p{Me}]/u.test(ch)) return 1;
  if (/\p{Mc}/u.test(ch)) return 2;
  if (EXTRA_WIDE.test(ch)) return 3;
  const cp = ch.codePointAt(0)!;
  return cp >= 0x1100 && !(NARROW_HIGH.test(ch) && !/\p{Extended_Pictographic}/u.test(ch)) ? 2 : 1;
}

/**
 * Screen columns a grapheme takes, at most: every code point in it counts (an emoji sequence a viewer cannot draw as one
 * picture shows each part), and one drawn as an emoji (U+FE0F, or a keycap) is at least two.
 */
export function columns(g: string): number {
  let n = 0;
  for (const ch of g) n += codePointColumns(ch);
  return Math.max(n, /[\uFE0F\u20E3]/u.test(g) ? 2 : 1);
}

/** One letter with at most `MAX_MARKS` nonspacing or enclosing marks. */
function thin(g: string): string {
  let marks = 0;
  let kept = "";
  for (const ch of g) {
    if (/[\p{Mn}\p{Me}]/u.test(ch) && ++marks > MAX_MARKS) continue;
    kept += ch;
  }
  return kept;
}

/**
 * One line of text: unprintables and tag characters gone (a subdivision flag shows as a plain black flag), overloaded
 * letters thinned, blanks as one space. Removing a character can join two letters into one, so thinning repeats until
 * nothing changes (each round only removes, so it ends).
 */
function clean(line: string): string {
  let text = wellFormed(line).replace(UNPRINTABLE, "").replace(/[\u{E0000}-\u{E007F}]/gu, "");
  for (let round = 0; round < 8; round++) {
    const next = graphemes(text).map(thin).join("");
    if (next === text) break;
    text = next;
  }
  return text.replace(BLANKS, " ");
}

/** A name or an email as one line: line breaks as spaces, then cleaned. */
function oneLine(text: string): string {
  return clean(text.split(LINE_BREAK).join(" ")).trim();
}

/**
 * Cuts a line at spaces into pieces of at most `first` columns, then `rest`; a word wider than that is cut between
 * letters, and a letter wider than a line between its code points, so no line is ever wider than its limit and no text
 * is lost or reordered.
 */
function wrap(line: string, first: number, rest: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let width = 0;
  const limit = () => (out.length ? rest : first);
  const flush = () => {
    out.push(cur.join(""));
    cur = [];
    width = 0;
  };
  for (const word of line.trim().split(" ")) {
    const letters = graphemes(word).flatMap((g) => (columns(g) > Math.min(first, rest) ? Array.from(g) : [g]));
    const sizes = letters.map(columns);
    const wordWidth = sizes.reduce((n, w) => n + w, 0);
    if (cur.length && width + 1 + wordWidth > limit()) flush();
    if (cur.length) {
      cur.push(" ");
      width += 1;
    }
    letters.forEach((g, i) => {
      if (cur.length && width + sizes[i] > limit()) {
        if (cur[cur.length - 1] === " ") cur.pop();
        flush();
      }
      cur.push(g);
      width += sizes[i];
    });
  }
  out.push(cur.join(""));
  return out;
}

/** `lead` and then `text`, cut into lines of at most `LINE_WIDTH` columns, every line after the first indented. */
function block(lead: string, text: string): string[] {
  if (!text) return [lead.trimEnd()];
  return wrap(text, LINE_WIDTH - lead.length, LINE_WIDTH - INDENT.length).map((piece, j) => `${j === 0 ? lead : INDENT}${piece}`);
}

/**
 * One visit as a plain-text file: who it was with, when it started and when its last message was, the visitor's name and
 * email when left, then each message with its time and speaker (`Visitor` or `Presenter`). Every value is cut into lines
 * of at most 76 columns, every line after its first indented, and kept to plain characters, so in a viewer at least that
 * wide nothing a visitor typed can start a line of the file or pass for a heading or another speaker. Times are UTC, as
 * the server has no reader's zone.
 */
export function transcriptText(agentName: string, c: Conversation): string {
  const head: string[] = [];
  const field = (label: string, value: string) => head.push(...block(`${label} `, value));
  field("Conversation with", oneLine(agentName));
  field("Started:", utc(c.startedAt));
  const last = c.messages.at(-1);
  if (last) field("Last message:", utc(last.at));
  if (c.visitor?.name && oneLine(c.visitor.name)) field("Visitor name:", oneLine(c.visitor.name));
  if (c.visitor?.email) field("Visitor email:", oneLine(c.visitor.email));
  // A new visit's first turn is stamped with its start; once the oldest messages roll off, the first left is later.
  if (c.messages.length >= MAX_TRANSCRIPT_MESSAGES && c.messages[0].at !== c.startedAt) {
    head.push(`Only the ${MAX_TRANSCRIPT_MESSAGES} newest messages were kept; earlier ones are not shown.`);
  }
  const body = c.messages.map((m) => {
    const prefix = `[${utc(m.at)}] ${m.role === "user" ? "Visitor" : "Presenter"}: `;
    // Blank lines are left out, so a message's text runs on in indented lines with no gap that could set part of it apart.
    const lines = m.content.split(LINE_BREAK).map((line) => clean(line).trim()).filter((line, i) => i === 0 || line);
    return lines.flatMap((line, i) => block(i === 0 ? prefix : INDENT, line)).join("\n");
  });
  return `${[...head, "", ...body].join("\n")}\n`;
}
