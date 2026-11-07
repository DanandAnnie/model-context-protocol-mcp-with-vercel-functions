// A visitor's search on a shared folder's page: the cards narrowed to the titles that hold what they typed.

/** A folder page lists at least this many videos before it offers a search; fewer fit on a screen or two. */
export const COLLECTION_SEARCH_MIN = 6;
/** The longest search the page keeps (in the box and in its address), in characters as a person counts them. */
export const COLLECTION_SEARCH_MAX = 100;

// Letters NFKD leaves whole (they carry no separable accent), read as the plain letters people type for them.
const PLAIN: Record<string, string> = { ł: "l", ø: "o", đ: "d", ð: "d", ħ: "h", ı: "i", ŧ: "t", ß: "ss", æ: "ae", œ: "oe", ς: "σ" };
const PLAIN_RE = new RegExp(`[${Object.keys(PLAIN).join("")}]`, "gu");

/**
 * Text folded for the search: one case and Unicode form, accents aside, so "cafe" finds "Café", "lodz" finds "Łódź", and
 * a decomposed "é" finds a composed one. A Greek final sigma reads as any other.
 */
export function foldForSearch(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(PLAIN_RE, (c) => PLAIN[c]);
}

/** Whether a title holds every word of the search, in any order ("oak 3 bed" finds "3 bed on Oak Street"). An empty search matches every title. */
export function titleMatches(title: string, query: string): boolean {
  const words = foldForSearch(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const folded = foldForSearch(title);
  return words.every((w) => folded.includes(w));
}

/** A search cut to the longest kept, by character (an emoji is one, never cut in half). */
export function cutSearch(text: string): string {
  const chars = Array.from(text);
  return chars.length > COLLECTION_SEARCH_MAX ? chars.slice(0, COLLECTION_SEARCH_MAX).join("") : text;
}

/** The search read from the page's address (`?q=`): the first value, cut to the longest kept; none for anything else. */
export function searchFromAddress(value: string | string[] | null | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? cutSearch(first) : "";
}
