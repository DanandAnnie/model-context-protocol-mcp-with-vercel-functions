// Brand glossary: terms a translation must leave exactly as written (product names, slogans, handles).
// Each one rides through the translator as a token it cannot change, then comes back as it stood in
// the source, so the guarantee does not depend on the model following an instruction.
import { PAUSE_MARKER } from "./pauses";

export const MAX_GLOSSARY_TERMS = 50;
export const MAX_GLOSSARY_TERM_LENGTH = 60;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Swaps every whole-word, case-insensitive occurrence of a term for a `[[T1]]`-style token (longest
 * terms first, so "Acme Cloud" wins over "Acme"), leaving pause markers and pause tokens alone. `restore`
 * puts each occurrence back exactly as the source spelled it; a token the translator dropped is simply
 * gone, and one it never had is left out.
 */
export function protectTerms(text: string, terms: string[]): { text: string; restore: (out: string) => string } {
  const unique = [...new Set(terms.map((t) => t.trim()).filter(Boolean).map((t) => t.toLowerCase()))];
  if (!unique.length) return { text, restore: (out) => out };
  const alternatives = unique.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const re = new RegExp(`(${PAUSE_MARKER}|\\[\\[P\\d+\\]\\])|(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "giu");
  const found: string[] = [];
  const guarded = text.replace(re, (m, skip?: string) => {
    if (skip) return m;
    found.push(m);
    return `[[T${found.length}]]`;
  });
  return {
    text: guarded,
    restore: (out) => out.replace(/\[\[\s*T(\d+)\s*\]\]/g, (_m, n: string) => found[Number(n) - 1] ?? ""),
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
