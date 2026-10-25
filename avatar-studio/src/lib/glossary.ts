// Brand glossary: terms a translation must leave exactly as written (product names, slogans, handles).
// Each one rides through the translator as a token it cannot change, then comes back as it stood in
// the source, so the spelling does not depend on the model following an instruction.
import { PAUSE_MARKER } from "./pauses";

export const MAX_GLOSSARY_TERMS = 50;
export const MIN_GLOSSARY_TERM_LENGTH = 2;
export const MAX_GLOSSARY_TERM_LENGTH = 60;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A character that continues a word in a script written with spaces: a letter, combining mark, digit,
 * or underscore (so "kamī", "Café" in decomposed form, and "@acme_cloud" are never split). Scripts written
 * without spaces between words (Chinese, Japanese, Thai, Lao, Khmer, Myanmar) are left out, so a term
 * next to one of their characters still counts as a whole word: "Nimbusを使って" protects "Nimbus".
 */
const WORD_CHAR = String.raw`(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}])[\p{L}\p{M}\p{N}_])`;
/** Text that already looks like a term token (`[[T1]]`, `[t 2]`); kept as written so a restore cannot take it for one. */
const TOKEN_LIKE = String.raw`\[{1,2}\s*T\s*\d+\s*\]{1,2}`;

/**
 * Swaps every whole, case-insensitive occurrence of a term for a `[[T1]]`-style token (longest terms
 * first, so "Acme Cloud" wins over "Acme"), stepping over pause markers and pause tokens. Text and terms
 * are compared in NFC, so a decomposed "Café" matches. `restore` puts each occurrence back as the source
 * spelled it, accepting the token in any case, with spaces, or with single brackets; a token the
 * translator dropped is simply gone. `terms` lists what each token stands for, in token order.
 */
export function protectTerms(text: string, terms: string[]): { text: string; terms: string[]; restore: (out: string) => string } {
  const unique = [...new Set(terms.map((t) => t.normalize("NFC").trim()).filter(Boolean).map((t) => t.toLowerCase()))];
  if (!unique.length) return { text, terms: [], restore: (out) => out };
  const alternatives = unique.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const re = new RegExp(`(${PAUSE_MARKER}|\\[\\[P\\d+\\]\\])|(${TOKEN_LIKE})|(?<!${WORD_CHAR})(?:${alternatives})(?!${WORD_CHAR})`, "giu");
  const found: string[] = [];
  const guarded = text.normalize("NFC").replace(re, (m, pause?: string) => {
    if (pause) return m;
    found.push(m);
    return `[[T${found.length}]]`;
  });
  return {
    text: guarded,
    terms: found,
    restore: (out) => out.replace(new RegExp(TOKEN_LIKE.replace(String.raw`\d+`, String.raw`(\d+)`), "gi"), (_m, n: string) => found[Number(n) - 1] ?? ""),
  };
}

/** One term per line; blank lines and repeats (ignoring case) are dropped. The caller checks the count. */
export function parseGlossary(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((t) => t && !seen.has(t.toLowerCase()) && !!seen.add(t.toLowerCase()));
}
