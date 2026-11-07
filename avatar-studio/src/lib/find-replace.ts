// Find and replace across a video's scenes, as a studio script editor offers: every occurrence in every scene's
// script, optionally matching case or whole words. Pause markers (`[pause 2s]`) and template placeholders
// (`{name}`) are never matched inside, so a search for "pause", "2s", or "name" cannot break one.
import { PAUSE_MARKER } from "./pauses";

export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Scripts written without spaces between words, where every character may start or end a word. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** What a search steps over: pause markers and template placeholders, as the editor and batches write them. */
const PROTECTED = new RegExp(`${PAUSE_MARKER}|\\{[\\p{L}_][\\p{L}\\p{N}_ -]{0,39}\\}`, "giu");

/**
 * The pattern for `find`, or null when there is nothing to look for. A whole word is bounded by anything but a letter,
 * mark, or digit; an end of `find` in a script written without spaces (Chinese, Japanese, Thai) needs no boundary.
 */
function pattern(find: string, { matchCase = false, wholeWord = false }: FindOptions): RegExp | null {
  const text = find.normalize("NFC");
  if (!text) return null;
  const chars = Array.from(text);
  const before = wholeWord && !UNSPACED.test(chars[0]) ? "(?<![\\p{L}\\p{M}\\p{N}_])" : "";
  const after = wholeWord && !UNSPACED.test(chars[chars.length - 1]) ? "(?![\\p{L}\\p{M}\\p{N}_])" : "";
  return new RegExp(`${before}${escape(text)}${after}`, `gu${matchCase ? "" : "i"}`);
}

/** The text (in composed form, so a typed "é" finds an imported "e" + accent) split around what a search steps over. */
function pieces(text: string): Array<{ text: string; kept: boolean }> {
  const composed = text.normalize("NFC");
  const out: Array<{ text: string; kept: boolean }> = [];
  let at = 0;
  for (const m of composed.matchAll(PROTECTED)) {
    const start = m.index ?? 0;
    if (start > at) out.push({ text: composed.slice(at, start), kept: false });
    out.push({ text: m[0], kept: true });
    at = start + m[0].length;
  }
  if (at < composed.length) out.push({ text: composed.slice(at), kept: false });
  return out;
}

/** How many times `find` occurs in each script (pause markers and placeholders left out). */
export function countMatches(scripts: string[], find: string, options: FindOptions = {}): number[] {
  const re = pattern(find, options);
  return scripts.map((s) => (re ? pieces(s).reduce((n, p) => n + (p.kept ? 0 : (p.text.match(re)?.length ?? 0)), 0) : 0));
}

/**
 * Every script with each occurrence of `find` replaced by `replacement` (taken literally), and how many were. A script
 * with no match comes back exactly as it was.
 */
export function replaceAll(scripts: string[], find: string, replacement: string, options: FindOptions = {}): { scripts: string[]; count: number } {
  const re = pattern(find, options);
  if (!re) return { scripts, count: 0 };
  let count = 0;
  const out = scripts.map((s) => {
    const before = count;
    const replaced = pieces(s)
      .map((p) =>
        p.kept
          ? p.text
          : p.text.replace(re, () => {
              count++;
              return replacement;
            }),
      )
      .join("");
    return count === before ? s : replaced;
  });
  return { scripts: out, count };
}
