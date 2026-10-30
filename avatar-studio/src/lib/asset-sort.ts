export type AssetSort = "newest" | "oldest" | "name";

export const ASSET_SORTS: ReadonlyArray<{ value: AssetSort; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name A–Z" },
];

type Rankable = { id: string; name: string; createdAt: string };

/**
 * Each asset's place in `sort` order, by id. Newest and oldest go by when it was added (ISO times, which order as
 * text), so a rename never moves it. Names compare as the person's language reads them (`locale`, the browser's by
 * default), with digits by value ("Take 2" before "Take 10") and case and accents breaking ties only; equal names go
 * newest first, and anything still equal by id, so the order is the same on every render.
 */
export function rankAssets(items: ReadonlyArray<Rankable>, sort: AssetSort, locale?: string): Map<string, number> {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const byTime = (a: Rankable, b: Rankable) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  const byId = (a: Rankable, b: Rankable) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const newest = (a: Rankable, b: Rankable) => byTime(b, a) || byId(a, b);
  const ordered = [...items].sort((a, b) => (sort === "name" ? collator.compare(a.name, b.name) || newest(a, b) : sort === "oldest" ? byTime(a, b) || byId(a, b) : newest(a, b)));
  return new Map(ordered.map((item, i) => [item.id, i]));
}

/** `list` as `rank` places it; anything `rank` has not placed (added since) comes first, in the list's own order. */
export function inRankOrder<T extends { id: string }>(list: ReadonlyArray<T>, rank: Map<string, number> | undefined): T[] {
  return rank ? [...list].sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1)) : [...list];
}

/** Whether `list` is already in `sort` order, i.e. sorting again would change nothing. */
export function inSortOrder(list: ReadonlyArray<Rankable>, sort: AssetSort, locale?: string): boolean {
  const rank = rankAssets(list, sort, locale);
  return list.every((item, i) => rank.get(item.id) === i);
}
