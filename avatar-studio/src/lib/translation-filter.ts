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
