// The Video translate page's list of translations: what its search looks through and how it is filtered by where each dub is.
import type { Translation } from "./types";

export type TranslationState = "moving" | "proofread" | "done" | "failed";
export type TranslationFilter = "all" | TranslationState;

export const TRANSLATION_FILTERS: ReadonlyArray<{ value: TranslationFilter; label: string; none: string }> = [
  { value: "all", label: "All", none: "" },
  { value: "moving", label: "In progress", none: "None of these translations are in progress." },
  { value: "proofread", label: "Ready to proofread", none: "None of these translations are waiting to be proofread." },
  { value: "done", label: "Finished", none: "None of these translations have finished yet." },
  { value: "failed", label: "Failed", none: "None of these translations have failed." },
];

/** A filter typed anywhere: one of the filters, or all for anything else. */
export function translationFilterFrom(value: string | null | undefined): TranslationFilter {
  return TRANSLATION_FILTERS.some((o) => o.value === value) ? (value as TranslationFilter) : "all";
}

/**
 * Where a dub is: its lines ready for someone to correct, finished, failed, or otherwise still being made (lines being
 * translated, corrected lines sent to be dubbed, or the dub running).
 */
export function translationState(t: Pick<Translation, "status" | "proofreadStage">): TranslationState {
  if (t.status === "completed") return "done";
  if (t.status === "failed") return "failed";
  return t.proofreadStage === "ready" ? "proofread" : "moving";
}

/** How many of the translations are in each state, and in all. */
export function translationCounts(items: ReadonlyArray<Pick<Translation, "status" | "proofreadStage">>): Record<TranslationFilter, number> {
  const counts: Record<TranslationFilter, number> = { all: items.length, moving: 0, proofread: 0, done: 0, failed: 0 };
  for (const t of items) counts[translationState(t)]++;
  return counts;
}

/** What the search looks through for a translation: its title, its language, and the site its source video is on. */
export function translationTexts(t: Pick<Translation, "title" | "targetLanguage" | "sourceVideoUrl">): string[] {
  let host = "";
  try {
    host = new URL(t.sourceVideoUrl).hostname;
  } catch {
    // A source that does not parse is not searched by site.
  }
  return [t.title, t.targetLanguage, host];
}

export type TranslationSort = "newest" | "oldest" | "title" | "language";

export const TRANSLATION_SORTS: ReadonlyArray<{ value: TranslationSort; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "title", label: "Title A–Z" },
  { value: "language", label: "Language A–Z" },
];

/** Where this browser keeps the Video translate list's sort. */
export const TRANSLATION_SORT_KEY = "avatar-studio:translations-sort";

/** A sort remembered by this browser (or typed anywhere): one of the sorts, or newest first for anything else. */
export function translationSortFrom(value: string | null | undefined): TranslationSort {
  return TRANSLATION_SORTS.some((o) => o.value === value) ? (value as TranslationSort) : "newest";
}

type Sortable = Pick<Translation, "id" | "title" | "targetLanguage" | "createdAt">;

/**
 * The translations in `sort` order. Newest and oldest go by when each was started (ISO times, which order as text).
 * Titles and languages compare as the person's language reads them (`locale`, the browser's by default), with digits
 * by value ("Part 2" before "Part 10"), ignoring case and accents; a language's dubs go by title. Anything still equal
 * goes newest first, and dubs started in the same moment (one request's languages) keep the order they came in, so the
 * order is the same on every render.
 */
export function sortTranslations<T extends Sortable>(items: ReadonlyArray<T>, sort: TranslationSort, locale?: string): T[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const at = new Map(items.map((t, i) => [t.id, i]));
  const byTime = (a: T, b: T) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  const asGiven = (a: T, b: T) => at.get(a.id)! - at.get(b.id)!;
  const newest = (a: T, b: T) => byTime(b, a) || asGiven(a, b);
  const compare: Record<TranslationSort, (a: T, b: T) => number> = {
    newest,
    oldest: (a, b) => byTime(a, b) || asGiven(a, b),
    title: (a, b) => collator.compare(a.title, b.title) || newest(a, b),
    language: (a, b) => collator.compare(a.targetLanguage, b.targetLanguage) || collator.compare(a.title, b.title) || newest(a, b),
  };
  return [...items].sort(compare[sort]);
}
