// Pronunciation rules: how the renderer should say a word, while the stored script and its captions
// keep the real spelling. Applied to the text handed to the provider only.
import type { Pronunciation, VideoRequest } from "./types";

export const MAX_PRONUNCIATIONS = 50;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces every whole-word, case-insensitive occurrence of each rule's word in one pass (longest
 * words first, so "Nair" never splits "Nairobi"). One pass means a spelling is never fed to the other
 * rules, and the replacer returns it verbatim, so "$&" or "ER" inside "Nye-er" stay as written.
 */
export function applyPronunciations(text: string, rules: Pronunciation[]): string {
  const bySpelling = new Map<string, string>();
  for (const rule of rules) {
    const word = rule.word.trim();
    if (word && !bySpelling.has(word.toLowerCase())) bySpelling.set(word.toLowerCase(), rule.sayAs);
  }
  if (bySpelling.size === 0) return text;
  const words = [...bySpelling.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, "giu");
  return text.replace(re, (m) => bySpelling.get(m.toLowerCase()) ?? m);
}

/** The request as the renderer should speak it: the script and every scene's script with the rules applied. */
export function spokenCopy<T extends Pick<VideoRequest, "script" | "scenes">>(req: T, rules: Pronunciation[]): T {
  if (!rules.length) return req;
  return {
    ...req,
    script: applyPronunciations(req.script, rules),
    ...(req.scenes ? { scenes: req.scenes.map((sc) => ({ ...sc, script: applyPronunciations(sc.script, rules) })) } : {}),
  };
}

/** One rule per line, "word = how to say it"; lines without "=" or with an empty side are skipped. The caller checks the count. */
export function parsePronunciations(text: string): Pronunciation[] {
  return text
    .split("\n")
    .map((line) => {
      const at = line.indexOf("=");
      if (at < 0) return null;
      const word = line.slice(0, at).trim();
      const sayAs = line.slice(at + 1).trim();
      return word && sayAs ? { word, sayAs } : null;
    })
    .filter((r): r is Pronunciation => r !== null);
}

export function formatPronunciations(rules: Pronunciation[]): string {
  return rules.map((r) => `${r.word} = ${r.sayAs}`).join("\n");
}
