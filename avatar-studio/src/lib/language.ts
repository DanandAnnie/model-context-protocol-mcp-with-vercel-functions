// Voice languages arrive in whatever form a provider uses: BCP 47 tags ("en-US"), bare codes
// ("en") or display names ("English", "Spanish"). The browser's speech APIs want a tag.

const CANDIDATE_CODES = [
  "en", "es", "fr", "de", "it", "pt", "nl", "sv", "da", "no", "fi", "pl", "cs", "sk", "hu", "ro", "bg", "el", "tr", "ru", "uk",
  "ar", "he", "fa", "hi", "bn", "ta", "te", "ur", "id", "ms", "th", "vi", "fil", "zh", "ja", "ko", "ca", "hr", "sr", "sl", "lt", "lv", "et", "sw", "af",
];

let byName: Map<string, string> | null = null;

/** Display names in English for the candidate codes, built once (Intl.DisplayNames is in every modern runtime). */
function namesToCodes(): Map<string, string> {
  if (byName) return byName;
  byName = new Map();
  try {
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    for (const code of CANDIDATE_CODES) {
      const name = names.of(code);
      if (name) byName.set(name.toLowerCase(), code);
    }
  } catch {
    // No Intl data: only tags and codes resolve.
  }
  // Spellings providers use that Intl does not.
  byName.set("mandarin", "zh");
  byName.set("chinese (mandarin)", "zh");
  byName.set("cantonese", "yue");
  byName.set("tagalog", "fil");
  byName.set("norwegian", "no");
  return byName;
}

const TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * A BCP 47 tag for a provider language value, or undefined when it cannot be resolved.
 * "en-US" → "en-US", "EN" → "en", "English" → "en", "Spanish (Mexico)" → "es", "klingon" → undefined.
 */
export function languageTag(input?: string | null): string | undefined {
  const value = input?.trim();
  if (!value) return undefined;
  if (TAG.test(value)) {
    const [lang, ...rest] = value.split("-");
    return [lang.toLowerCase(), ...rest.map((p) => (p.length === 2 ? p.toUpperCase() : p))].join("-");
  }
  const name = value.toLowerCase().replace(/\s*\(.*\)\s*$/, "").trim();
  return namesToCodes().get(name);
}

/** Two-letter language part of a tag or name ("en-US" → "en", "English" → "en"). */
export function languageCode(input?: string | null): string | undefined {
  return languageTag(input)?.split("-")[0];
}
