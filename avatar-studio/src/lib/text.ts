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

/**
 * A URL as a CSS `url("…")` value. Quotes, backslashes, and control characters are percent-encoded, so
 * the value cannot end the string early; React sets it through the style object, never as markup.
 */
export function cssUrl(url: string): string {
  return `url("${url.replace(/["\\\u0000-\u001f\u007f]/g, (c) => encodeURIComponent(c))}")`;
}
