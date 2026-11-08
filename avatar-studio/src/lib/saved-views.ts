// Saved views in the library: a name for a search and filters, kept in this browser, that opens the library at them again.

/** How many views a space keeps; saving one more lets the oldest go. */
export const SAVED_VIEWS_MAX = 12;
/** The longest name a view takes, in characters. */
export const SAVED_VIEW_NAME_MAX = 40;
/** The longest query a view keeps (the library's own search and filters stay well under it). */
const SAVED_VIEW_QUERY_MAX = 2000;

/** The library's own search and filters: what a view keeps (not a batch's results, which belong to that one visit). */
export const SAVED_VIEW_PARAMS = ["q", "status", "folder", "presenter", "voice", "review", "share", "comments", "created", "shape", "length", "viewed", "starred"] as const;

export interface SavedView {
  name: string;
  /** The library address's query without "?", only SAVED_VIEW_PARAMS, e.g. `status=failed&created=7d`. */
  query: string;
}

/** Where a person's views are kept in this browser: one list per person and space (a workspace, or their own). */
export const savedViewsKey = (space: string) => `avatar-studio:library-views:${space}`;

/** The characters of a text as a reader sees them: an emoji made of several code points (a flag, a family) is one. */
function characters(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  return Array.from(text);
}

/** A view name as kept: spaces folded, cut to SAVED_VIEW_NAME_MAX characters (not halfway through one). */
export function viewName(raw: string): string {
  return characters(raw.replace(/\s+/g, " ").trim()).slice(0, SAVED_VIEW_NAME_MAX).join("").trim();
}

/** A query with only the library's own search and filters, in the order given. */
export function viewQuery(search: string): string {
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const [k, v] of params) if ((SAVED_VIEW_PARAMS as readonly string[]).includes(k) && !kept.has(k)) kept.set(k, v);
  return kept.toString();
}

/** Two queries asking for the same videos, whatever their order or spelling. */
export function sameView(a: string, b: string): boolean {
  const key = (s: string) => {
    const p = new URLSearchParams(viewQuery(s));
    return SAVED_VIEW_PARAMS.map((k) => (p.has(k) ? `=${p.get(k)}` : "")).join("\u0000");
  };
  return key(a) === key(b);
}

/** The views kept under a key, or none when there are none or what is there is not a list of views. */
export function readSavedViews(raw: string | null): SavedView[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const views: SavedView[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { name, query } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof query !== "string" || query.length > SAVED_VIEW_QUERY_MAX) continue;
    const clean = viewName(name);
    if (!clean || views.some((v) => sameName(v.name, clean))) continue;
    views.push({ name: clean, query: viewQuery(query) });
  }
  return views.slice(-SAVED_VIEWS_MAX);
}

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/**
 * The views with one saved under a name: a view of the same name (case aside) takes the new search and filters where it
 * is; a new one goes last, and the oldest goes once there are more than SAVED_VIEWS_MAX. A blank name changes nothing.
 */
export function withSavedView(views: SavedView[], name: string, search: string): SavedView[] {
  const clean = viewName(name);
  if (!clean) return views;
  const query = viewQuery(search);
  const at = views.findIndex((v) => sameName(v.name, clean));
  if (at >= 0) return views.map((v, i) => (i === at ? { name: clean, query } : v));
  return [...views, { name: clean, query }].slice(-SAVED_VIEWS_MAX);
}

/** The views without the one of that name. */
export function withoutSavedView(views: SavedView[], name: string): SavedView[] {
  return views.filter((v) => !sameName(v.name, name));
}
