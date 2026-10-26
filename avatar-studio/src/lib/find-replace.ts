// Find and replace across a video's scenes, as a studio script editor offers: every occurrence in every scene's
// script, optionally matching case or whole words. Pause markers (`[pause 2s]`) are never matched inside, so a
// search for "pause" or "2s" cannot break one.
import { PAUSE_MARKER } from "./pauses";

export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The pattern for `find`, or null when there is nothing to look for. Whole words are letters, marks, and digits. */
function pattern(find: string, { matchCase = false, wholeWord = false }: FindOptions): RegExp | null {
  if (!find) return null;
  const body = escape(find);
  const word = wholeWord ? `(?<![\\p{L}\\p{M}\\p{N}_])${body}(?![\\p{L}\\p{M}\\p{N}_])` : body;
  return new RegExp(word, `gu${matchCase ? "" : "i"}`);
}

/** The text split into the parts a search may look at and the pause markers it must leave alone. */
function pieces(text: string): Array<{ text: string; marker: boolean }> {
  const out: Array<{ text: string; marker: boolean }> = [];
  let at = 0;
  for (const m of text.matchAll(new RegExp(PAUSE_MARKER, "gi"))) {
    const start = m.index ?? 0;
    if (start > at) out.push({ text: text.slice(at, start), marker: false });
    out.push({ text: m[0], marker: true });
    at = start + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), marker: false });
  return out;
}

/** How many times `find` occurs in each script (pause markers left out). */
export function countMatches(scripts: string[], find: string, options: FindOptions = {}): number[] {
  const re = pattern(find, options);
  return scripts.map((s) => (re ? pieces(s).reduce((n, p) => n + (p.marker ? 0 : (p.text.match(re)?.length ?? 0)), 0) : 0));
}

/** Every script with each occurrence of `find` replaced by `replacement` (taken literally), and how many were. */
export function replaceAll(scripts: string[], find: string, replacement: string, options: FindOptions = {}): { scripts: string[]; count: number } {
  const re = pattern(find, options);
  if (!re) return { scripts, count: 0 };
  let count = 0;
  const out = scripts.map((s) =>
    pieces(s)
      .map((p) =>
        p.marker
          ? p.text
          : p.text.replace(re, () => {
              count++;
              return replacement;
            }),
      )
      .join(""),
  );
  return { scripts: out, count };
}
