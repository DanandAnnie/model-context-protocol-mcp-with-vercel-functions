/** Half of a surrogate pair with no other half, as a string cut mid-emoji ends with; `encodeURIComponent` throws on one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The string with any lone surrogate replaced (by U+FFFD unless told otherwise), so it can always be URL-encoded. */
export function wellFormed(text: string, replacement = "\uFFFD"): string {
  return text.replace(LONE_SURROGATE, replacement);
}

/** A one-line excerpt for link previews: whitespace collapsed, cut at a word boundary, with an ellipsis. */
export function excerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat); // code points, so an emoji or CJK character is never cut in half
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max - 1).join("");
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > max / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** A point in a video as a player shows it: `m:ss`, or `h:mm:ss` from an hour on; fractions are dropped. */
export function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}


const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
/** The characters a reader sees (a flag, an emoji with a skin tone, a letter with its accent each one), in order. */
export function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}
