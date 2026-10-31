"use client";
import { useId, useState } from "react";
import { inputClass } from "@/components/ui";
import { foldTerm } from "@/lib/glossary";

export type ListSearchState = ReturnType<typeof useListSearch>;

/**
 * A search over a list shown on the page, compared in one case and Unicode form (a name typed on macOS can arrive
 * decomposed). What is started or renamed while a search is typed is pinned, so it stays in view rather than vanishing
 * from under the person (or their focus) until the search changes.
 */
export function useListSearch() {
  const [q, setQ] = useState("");
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const needle = foldTerm(q.trim());
  return {
    q,
    needle,
    search: (value: string) => {
      setQ(value);
      setPinned(new Set());
    },
    pin: (id: string) => setPinned((prev) => (prev.has(id) ? prev : new Set(prev).add(id))),
    matches: (id: string, ...texts: Array<string | undefined>) => !needle || pinned.has(id) || texts.some((t) => !!t && foldTerm(t).includes(needle)),
  };
}

/**
 * The search box over a list, with how many of it match read out as the search changes. It stays on the page once the
 * list has anything in it, so clearing it never takes it (and the focus in it) away.
 */
export function ListSearch(props: { search: ListSearchState; label: string; placeholder: string; shown: number; total: number; noun: string; maxLength?: number }) {
  const id = useId();
  const { search, shown, total, noun } = props;
  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-3">
        <input type="search" aria-label={props.label} aria-describedby={id} className={`${inputClass} max-w-xs`} placeholder={props.placeholder} maxLength={props.maxLength} value={search.q} onChange={(e) => search.search(e.target.value)} />
        <span id={id} role="status" className="text-xs text-slate-500" data-testid="list-matches">
          {search.needle && total > 0 ? `${shown} of ${total} ${noun}` : ""}
        </span>
      </div>
      {search.needle && shown === 0 && total > 0 && <p className="mt-3 text-sm text-slate-600">Nothing here matches “{search.q.trim()}”.</p>}
    </div>
  );
}
