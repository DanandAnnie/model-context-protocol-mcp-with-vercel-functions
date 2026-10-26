// Brand glossary: terms a translation must leave exactly as written (product names, slogans, handles).
// Each one rides through the translator as a token it cannot change, then comes back as it stood in
// the source, so the spelling does not depend on the model following an instruction.
import { PAUSE_MARKER } from "./pauses";

export const MAX_GLOSSARY_TERMS = 50;
export const MIN_GLOSSARY_TERM_LENGTH = 2;
export const MAX_GLOSSARY_TERM_LENGTH = 60;
export const MAX_FORCED_TRANSLATIONS = 50;
export const MAX_FORCED_TRANSLATION_LENGTH = 80;

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
export function protectTerms(
  text: string,
  terms: string[],
  /** Terms (lowercase, NFC) that come back as a fixed translation instead of their source spelling. */
  replacements: Map<string, string> = new Map(),
): { text: string; terms: string[]; restore: (out: string) => string } {
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
    restore: (out) =>
      out.replace(new RegExp(TOKEN_LIKE.replace(String.raw`\d+`, String.raw`(\d+)`), "gi"), (_m, n: string) => {
        const term = found[Number(n) - 1];
        return term === undefined ? "" : (replacements.get(term.toLowerCase()) ?? term);
      }),
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

/** A language name without its region, lowercased: "Spanish (Mexico)" and "spanish" are both "spanish". */
function baseLanguage(language: string): string {
  return language.replace(/\(.*\)/, "").trim().toLowerCase();
}

/**
 * The rules that apply to a translation into `language`, one per term (ignoring case): a rule written for that
 * language (or for its base, so a "Spanish" rule covers "Spanish (Mexico)") beats one for every language.
 */
export function forcedFor(rules: Array<{ term: string; translation: string; language?: string }> | undefined, language: string | undefined): Array<{ term: string; translation: string }> {
  const target = language ? language.trim().toLowerCase() : "";
  const byTerm = new Map<string, { term: string; translation: string; rank: number }>();
  for (const r of rules ?? []) {
    const rank = !r.language ? 1 : r.language.trim().toLowerCase() === target ? 3 : target && baseLanguage(r.language) === baseLanguage(target) ? 2 : 0;
    if (!rank) continue;
    const key = r.term.normalize("NFC").trim().toLowerCase();
    const held = byTerm.get(key);
    if (!held || rank > held.rank) byTerm.set(key, { term: r.term, translation: r.translation, rank });
  }
  return [...byTerm.values()].map(({ term, translation }) => ({ term, translation }));
}

/**
 * One rule per line, `term = translation`, with an optional `[Language]` at the end for a rule that holds in
 * that language only. Lines without " = " are reported by number; a repeat (same term and language, ignoring
 * case) keeps the first. The caller checks the count and lengths.
 */
export function parseForcedTranslations(text: string): { rules: Array<{ term: string; translation: string; language?: string }>; bad: number[] } {
  const rules: Array<{ term: string; translation: string; language?: string }> = [];
  const bad: number[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const at = line.indexOf("=");
    if (at < 0) return void bad.push(i + 1);
    const term = line.slice(0, at).trim();
    let translation = line.slice(at + 1).trim();
    let language: string | undefined;
    const tag = /\s*\[([^\]]+)\]\s*$/.exec(translation);
    if (tag) {
      language = tag[1].trim() || undefined;
      translation = translation.slice(0, tag.index).trim();
    }
    if (!term || !translation) return void bad.push(i + 1);
    const key = `${term.toLowerCase()}\u0000${(language ?? "").toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({ term, translation, ...(language ? { language } : {}) });
  });
  return { rules, bad };
}

/** The rules as the brand page shows them, one per line. */
export function formatForcedTranslations(rules: Array<{ term: string; translation: string; language?: string }> | undefined): string {
  return (rules ?? []).map((r) => `${r.term} = ${r.translation}${r.language ? ` [${r.language}]` : ""}`).join("\n");
}
