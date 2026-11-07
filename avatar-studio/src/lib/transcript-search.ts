/**
 * Finding words in a transcript (the share page's search box): every place a phrase occurs in the lines, ignoring case,
 * accents, and runs of spaces, with offsets into each line's own text so the match can be marked where it stands.
 * A plain module, so the rules can be tested without a page.
 */

/** One occurrence: the line it is in, and where in that line's text it starts and ends. */
export type TranscriptMatch = { line: number; start: number; end: number };

/** The longest phrase searched: anything longer is cut, so a pasted paragraph cannot stall the page. */
export const TRANSCRIPT_QUERY_MAX = 100;

/**
 * A character as it is compared: lower case, without the accents Latin, Greek, and Cyrillic letters carry ("É" → "e")
 * or an emoji's presentation selectors,
 * compatibility forms spelt out ("ﬁ" → "fi"), "ß" as "ss" and final sigma as sigma; a space of any kind is a space.
 * Only those accents go: marks that change the letter elsewhere (the Japanese dakuten, か/が) stay, and syllables split
 * into parts by the decomposition (Korean Hangul) are put back together, so "가" does not find "각".
 */
function fold(ch: string): string {
  if (/\s/u.test(ch)) return " ";
  return ch
    .normalize("NFKD")
    // Accents, and the selectors that only pick how an emoji is drawn (❤️, 1️⃣).
    .replace(/[\u0300-\u036f\ufe00-\ufe0f\u20e3]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ς/g, "σ");
}

/**
 * The text as it is compared, and for each compared character the offset of the character in `text` it came from.
 * Runs of spaces count as one, so "two  words" matches "two words".
 */
function folded(text: string): { s: string; at: number[] } {
  let s = "";
  const at: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = fold(ch);
    if (!(f === " " && s.endsWith(" "))) {
      // By UTF-16 unit, as indexOf counts: a character outside the basic plane is two units of the same character.
      for (let j = 0; j < f.length; j++) {
        s += f[j];
        at.push(i);
      }
    }
    i += ch.length;
  }
  at.push(i);
  return { s, at };
}

/** The phrase as it is searched for: trimmed, cut to the longest searched, compared as the lines are. */
export function searchPhrase(query: string): string {
  return folded(query.trim().slice(0, TRANSCRIPT_QUERY_MAX)).s.trim();
}

/** Every occurrence of `query` in the lines, in order; none for a blank query. Occurrences do not overlap. */
export function findInTranscript(lines: string[], query: string): TranscriptMatch[] {
  const phrase = searchPhrase(query);
  if (!phrase) return [];
  const out: TranscriptMatch[] = [];
  lines.forEach((text, line) => {
    const { s, at } = folded(text);
    let from = 0;
    let lastEnd = -1;
    for (;;) {
      const k = s.indexOf(phrase, from);
      if (k < 0) break;
      from = k + phrase.length;
      // From the first character of the match to just past the last one, in the line's own text, taking in the marks
      // that follow it and compare as nothing (an accent written apart, an emoji's variation selector, a keycap).
      const last = at[k + phrase.length - 1];
      const start = at[k];
      const end = Math.max(last + (text.codePointAt(last)! > 0xffff ? 2 : 1), at[k + phrase.length]);
      // One character can compare as two ("ß" as "ss"): a match inside the one just marked is not marked again.
      if (start < lastEnd) continue;
      out.push({ line, start, end });
      lastEnd = end;
    }
  });
  return out;
}

/**
 * A line's text in pieces: plain, or a match (with its index among all the matches), for marking. `from` and `to` narrow
 * the matches looked at to that line's own (they are in line order), so a long transcript is not scanned per line.
 */
export function markLine(text: string, line: number, matches: TranscriptMatch[], from = 0, to = matches.length): Array<{ text: string; match?: number }> {
  const pieces: Array<{ text: string; match?: number }> = [];
  let pos = 0;
  for (let index = from; index < to; index++) {
    const m = matches[index];
    if (m.line !== line) continue;
    if (m.start > pos) pieces.push({ text: text.slice(pos, m.start) });
    pieces.push({ text: text.slice(m.start, m.end), match: index });
    pos = m.end;
  }
  if (pos < text.length || !pieces.length) pieces.push({ text: text.slice(pos) });
  return pieces;
}

/** For each line with matches, the range of their indices among all the matches. */
export function matchesByLine(matches: TranscriptMatch[]): Map<number, [number, number]> {
  const by = new Map<number, [number, number]>();
  matches.forEach((m, i) => {
    const r = by.get(m.line);
    if (r) r[1] = i + 1;
    else by.set(m.line, [i, i + 1]);
  });
  return by;
}

/** The match to move to from `current` (−1 for none yet), one step on or back, going round at either end. */
export function stepMatch(current: number, count: number, back = false): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return back ? count - 1 : 0;
  return (current + (back ? count - 1 : 1)) % count;
}
