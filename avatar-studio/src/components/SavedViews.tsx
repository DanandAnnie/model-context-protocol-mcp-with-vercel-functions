"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BookmarkPlus, X } from "lucide-react";
import { SAVED_VIEW_NAME_MAX, readSavedViews, sameView, savedViewsKey, viewName, withSavedView, withoutSavedView, type SavedView } from "@/lib/saved-views";

/**
 * Saved views over the library's list: named searches and filters, each a link that opens the library at them again,
 * kept in this browser for the space being worked in. "Save view" names what the filters show now; a name already used
 * takes the new filters.
 */
export function SavedViews({ query, canSave, space, onEmpty }: { query: string; canSave: boolean; space: string; onEmpty: () => void }) {
  const key = savedViewsKey(space);
  const [views, setViews] = useState<SavedView[]>([]);
  // What storage holds now, or null when it cannot be read (a private window, say).
  const stored = (): SavedView[] | null => {
    try {
      return readSavedViews(window.localStorage.getItem(key));
    } catch {
      return null;
    }
  };
  // Read after mounting (storage is the browser's), again for another space, and when another tab changes them.
  useEffect(() => {
    setViews(stored() ?? []);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setViews(readSavedViews(e.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // stored() reads the key given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // A change starts from what storage holds now, so one saved in another tab since is kept.
  function keep(change: (from: SavedView[]) => SavedView[]) {
    const next = change(stored() ?? views);
    setViews(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Not kept for next time, but shown for this visit.
    }
    return next;
  }

  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const openerRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (naming) fieldRef.current?.focus();
  }, [naming]);
  // The form goes with the filters (Clear filters, say), so it does not come back half typed with the next one.
  useEffect(() => {
    if (!canSave) {
      setNaming(false);
      setName("");
    }
  }, [canSave]);
  function say(text: string) {
    // Cleared first, so the same words said again are heard again.
    setNote("");
    requestAnimationFrame(() => setNote(text));
  }
  function close() {
    setNaming(false);
    setName("");
    requestAnimationFrame(() => openerRef.current?.focus());
  }
  function save() {
    const clean = viewName(name);
    if (!clean) {
      fieldRef.current?.focus();
      return;
    }
    const replaced = views.some((v) => v.name.localeCompare(clean, undefined, { sensitivity: "accent" }) === 0);
    keep((from) => withSavedView(from, clean, query));
    say(replaced ? `View “${clean}” updated` : `View “${clean}” saved`);
    close();
  }
  function remove(view: SavedView, at: number) {
    keep((from) => withoutSavedView(from, view.name));
    say(`View “${view.name}” removed`);
    // The focus goes to the next view's link, or the one before, or Save view when none is left, or the search box.
    requestAnimationFrame(() => {
      const links = listRef.current?.querySelectorAll<HTMLAnchorElement>("a");
      const next = links?.[Math.min(at, (links?.length ?? 1) - 1)] ?? openerRef.current;
      if (next) next.focus();
      else onEmpty();
    });
  }

  // With no view and nothing to save the row goes, but its status stays, so the last removal is still heard.
  const empty = views.length === 0 && !canSave;
  return (
    <div className={empty ? "contents" : "mb-4 flex flex-wrap items-center gap-2 text-xs"} data-testid="saved-views">
      {views.length > 0 && (
        <>
          <span className="font-medium text-slate-500" id="saved-views-label">
            Saved views
          </span>
          <ul ref={listRef} aria-labelledby="saved-views-label" className="flex flex-wrap items-center gap-2">
            {views.map((v, i) => {
              const current = !!query && sameView(v.query, query);
              return (
                <li key={v.name} className={`inline-flex max-w-full items-center rounded-full border ${current ? "border-brand-600 bg-brand-50" : "border-slate-200 bg-white"}`}>
                  <Link
                    href={v.query ? `/videos?${v.query}` : "/videos"}
                    aria-current={current ? "true" : undefined}
                    className={`max-w-[16rem] truncate rounded-l-full py-1 pl-3 pr-1 font-medium hover:underline ${current ? "text-brand-800" : "text-slate-700"}`}
                    title={v.name}
                    data-testid="saved-view"
                  >
                    {v.name}
                  </Link>
                  <button type="button" onClick={() => remove(v, i)} aria-label={`Remove view ${v.name}`} title="Remove this view" className="rounded-r-full py-1 pl-1 pr-2 text-slate-400 hover:text-slate-700">
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {canSave && !naming && (
        <button ref={openerRef} type="button" onClick={() => setNaming(true)} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium text-brand-700 hover:bg-slate-100" title="Name this search and these filters, to open the library at them again" data-testid="save-view">
          <BookmarkPlus className="h-3.5 w-3.5" aria-hidden /> Save view
        </button>
      )}
      {canSave && naming && (
        <form
          className="inline-flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            ref={fieldRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
            aria-label="View name"
            placeholder="Name this view"
            maxLength={SAVED_VIEW_NAME_MAX * 2}
            className="w-44 rounded-full border border-slate-200 px-3 py-1"
          />
          <button type="submit" className="rounded-full bg-slate-900 px-3 py-1 font-medium text-white hover:bg-slate-800">
            Save
          </button>
          <button type="button" onClick={close} className="rounded-full px-2 py-1 font-medium text-slate-600 hover:bg-slate-100">
            Cancel
          </button>
        </form>
      )}
      <span role="status" className="sr-only" data-testid="saved-views-note">
        {note}
      </span>
    </div>
  );
}
