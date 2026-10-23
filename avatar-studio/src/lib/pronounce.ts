// Pronunciation rules: how the renderer should say a word, while the stored script and its captions
// keep the real spelling. Applied to the text handed to the provider only.
import type { Pronunciation, VideoRequest } from "./types";

export const MAX_PRONUNCIATIONS = 50;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces every whole-word, case-insensitive occurrence of each rule's word; longer words first so "Nair" never splits "Nairobi". */
export function applyPronunciations(text: string, rules: Pronunciation[]): string {
  let out = text;
  for (const rule of [...rules].sort((a, b) => b.word.length - a.word.length)) {
    if (!rule.word.trim()) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(rule.word.trim())}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, () => rule.sayAs); // a function, so "$&" or "$1" in the spelling is spoken literally
  }
  return out;
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

/** One rule per line, "word = how to say it"; lines without "=" or with an empty side are skipped. */
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
    .filter((r): r is Pronunciation => r !== null)
    .slice(0, MAX_PRONUNCIATIONS);
}

export function formatPronunciations(rules: Pronunciation[]): string {
  return rules.map((r) => `${r.word} = ${r.sayAs}`).join("\n");
}
