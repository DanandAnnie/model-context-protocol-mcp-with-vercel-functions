// Pronunciation rules: how the renderer should say a word, while the stored script and its captions
// keep the real spelling. Applied to the text handed to the provider only.
import { baseLanguageCode } from "./language";
import { PAUSE_MARKER } from "./pauses";
import type { Pronunciation, VideoRequest, Voice } from "./types";

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
  // A pause marker is matched first and handed back as written, so a rule for "pause" never rewrites one.
  const re = new RegExp(`(${PAUSE_MARKER})|(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, "giu");
  return text.replace(re, (m, marker?: string) => (marker ? m : (bySpelling.get(m.toLowerCase()) ?? m)));
}

/** Codes some providers give a language by, as the code its name resolves to ("nb-NO" is Norwegian, "iw" Hebrew). */
const SAME_LANGUAGE: Record<string, string> = { nb: "no", nn: "no", tl: "fil", iw: "he", in: "id", ji: "yi", cmn: "zh" };

/**
 * The base code of the language a rule names or a voice speaks ("French", "fr-CA", "pt_BR"), or undefined when it
 * names none: a word that only looks like a code ("sic", "USA") is not a language the runtime knows.
 */
export function pronunciationLanguage(input: string | undefined): string | undefined {
  const named = input?.trim().replace(/_/g, "-");
  const found = named ? baseLanguageCode(named) : undefined;
  if (!found) return undefined;
  const code = SAME_LANGUAGE[found] ?? found;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) === code ? undefined : code;
  } catch {
    return code; // No Intl data: the code is taken as given.
  }
}

/**
 * The rules that apply to speech in `language` (a voice's tag such as "fr-FR", or a name such as "French"), one per
 * word ignoring case: a rule for that language, whatever its region, beats a rule for every language; between equals
 * the first listed wins. A rule for a language applies nowhere when `language` is unknown or another one.
 */
export function pronunciationsFor(rules: Pronunciation[] | undefined, language: string | undefined): Pronunciation[] {
  const code = pronunciationLanguage(language);
  const byWord = new Map<string, { rule: Pronunciation; rank: number }>();
  for (const r of rules ?? []) {
    const rank = !r.language ? 1 : code && pronunciationLanguage(r.language) === code ? 2 : 0;
    if (!rank) continue;
    const key = r.word.trim().toLowerCase();
    const held = byWord.get(key);
    if (!held || rank > held.rank) byWord.set(key, { rule: { word: r.word, sayAs: r.sayAs }, rank });
  }
  return [...byWord.values()].map(({ rule }) => rule);
}

/**
 * The request as the renderer should speak it: the script and every scene's script with the rules for the language
 * of the voice that speaks it (the scene's own, else the video's, looked up in `voices`) applied.
 */
export function spokenCopy<T extends Pick<VideoRequest, "script" | "scenes"> & { voiceId?: string }>(req: T, rules: Pronunciation[], voices: Record<string, Pick<Voice, "language">> = {}): T {
  if (!rules.length) return req;
  const said = (voiceId: string | undefined) => pronunciationsFor(rules, voiceId ? voices[voiceId]?.language : undefined);
  return {
    ...req,
    script: applyPronunciations(req.script, said(req.voiceId)),
    ...(req.scenes ? { scenes: req.scenes.map((sc) => ({ ...sc, script: applyPronunciations(sc.script, said(sc.voiceId ?? req.voiceId)) })) } : {}),
  };
}

/**
 * One rule per line, "word = how to say it", with an optional `[Language]` at the end for a rule that holds in that
 * language only (an empty `[]` is a rule for every language, so a spelling that itself ends in a bracket can be
 * written). Lines without "=", or with an empty side and no bracket, are skipped; a bracket that names no language,
 * or a line with a bracket but no word or spelling, is reported by line number. The caller checks the count.
 */
export function parsePronunciations(text: string): { rules: Pronunciation[]; bad: number[]; badLanguage: Array<{ line: number; language: string }> } {
  const rules: Pronunciation[] = [];
  const bad: number[] = [];
  const badLanguage: Array<{ line: number; language: string }> = [];
  text.split("\n").forEach((line, i) => {
    const at = line.indexOf("=");
    if (at < 0) return;
    const word = line.slice(0, at).trim();
    let sayAs = line.slice(at + 1).trim();
    let language: string | undefined;
    const tag = /\s*\[([^\]]*)\]\s*$/.exec(sayAs);
    if (tag) {
      language = tag[1].trim() || undefined;
      sayAs = sayAs.slice(0, tag.index).trim();
      // A bracket that names no language would never apply; it is pointed out rather than kept quietly.
      if (language && !pronunciationLanguage(language)) return void badLanguage.push({ line: i + 1, language });
      if (!word || !sayAs) return void bad.push(i + 1);
    }
    if (word && sayAs) rules.push({ word, sayAs, ...(language ? { language } : {}) });
  });
  return { rules, bad, badLanguage };
}

/** The rules as the brand page shows them; a rule for every language whose spelling ends in "]" is marked with "[]". */
export function formatPronunciations(rules: Pronunciation[]): string {
  return rules.map((r) => `${r.word} = ${r.sayAs}${r.language ? ` [${r.language}]` : r.sayAs.trimEnd().endsWith("]") ? " []" : ""}`).join("\n");
}
