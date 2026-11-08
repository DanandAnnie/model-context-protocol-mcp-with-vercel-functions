"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Lock, Play, Search } from "lucide-react";
import type { CollectionVideo } from "@/lib/services/collections";
import { formatSeconds } from "@/lib/client";
import { COLLECTION_SEARCH_MIN, cutSearch, searchFromAddress, titleMatches } from "@/lib/collection-search";

/**
 * A shared folder's video cards, each opening that video's share page (in a new tab on another website). A folder of
 * COLLECTION_SEARCH_MIN videos or more gets a search box over their titles, kept in the page's address so Back from a
 * video (a card, Play all, or Up next), or a link someone copies, comes back to the same search. It covers the videos the
 * page lists (the first 100 in its order).
 */
export function CollectionVideos({ videos, embed }: { videos: CollectionVideo[]; embed: boolean }) {
  const searchable = videos.length >= COLLECTION_SEARCH_MIN;
  // Read from the address the router holds rather than from the server's render: Back after a move within the app
  // (Play all, Up next) restores the page from its cache, whose render predates the search.
  const params = useSearchParams();
  const [q, setQ] = useState(() => (searchable ? searchFromAddress(params.get("q")) : ""));
  const input = useRef<HTMLInputElement>(null);
  const countId = useId();
  const typed = q.trim();
  const shown = typed ? videos.filter((v) => titleMatches(v.title, typed)) : videos;

  // The address follows the search once typing pauses, without a new history entry, so Back still leaves the page in
  // one step. A null state lets the router take the new address in as its own. Some browsers refuse rapid history
  // writes (Safari throws after about 100 in 10 seconds); a refused one leaves the address as it was, not the page broken.
  useEffect(() => {
    if (!searchable) return;
    const timer = window.setTimeout(() => {
      const url = new URL(window.location.href);
      if (typed) url.searchParams.set("q", typed);
      else url.searchParams.delete("q");
      if (url.href === window.location.href) return;
      try {
        window.history.replaceState(null, "", url);
      } catch {
        // Left as it was.
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [typed, searchable]);

  const clear = () => {
    setQ("");
    input.current?.focus();
  };

  return (
    <>
      {searchable && (
        <div className="mt-6 flex flex-wrap items-center gap-3" role="search" data-testid="collection-search">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              ref={input}
              type="search"
              value={q}
              onChange={(e) => setQ(cutSearch(e.target.value))}
              onKeyDown={(e) => {
                // Escape empties the box in every browser, not only those whose search fields do it themselves.
                if (e.key === "Escape" && q) {
                  e.preventDefault();
                  setQ("");
                }
              }}
              aria-label="Search this folder's videos"
              aria-describedby={countId}
              placeholder="Search videos"
              className="w-full rounded-lg border border-slate-500 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/40"
              data-testid="collection-search-input"
            />
          </div>
          <span id={countId} role="status" className="text-sm text-slate-400" data-testid="collection-search-count">
            {typed ? `${shown.length} of ${videos.length} videos` : ""}
          </span>
        </div>
      )}
      {typed && shown.length === 0 && (
        <p className="mt-4 text-sm text-slate-300" data-testid="collection-search-empty">
          No video here matches your search.{" "}
          <button type="button" onClick={clear} className="font-medium text-brand-300 underline underline-offset-2 hover:text-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
            Clear search
          </button>
        </p>
      )}
      {shown.length > 0 && (
        <ul className={`${searchable ? "mt-4" : "mt-6"} grid gap-5 sm:grid-cols-2 lg:grid-cols-3`} data-testid="collection-videos">
          {shown.map((v) => (
            <li key={v.id}>
              <a href={`/share/${v.id}`} {...(embed ? { target: "_blank", rel: "noopener" } : {})} className="group block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400" data-testid="collection-video">
                <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-800">
                  {v.poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.poster} alt="" className="h-full w-full object-cover transition group-hover:opacity-90" loading="lazy" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-slate-500">
                      {v.locked ? <Lock className="h-8 w-8" aria-hidden /> : <Play className="h-8 w-8" aria-hidden />}
                    </div>
                  )}
                  {v.durationSec != null && (
                    <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">{formatSeconds(v.durationSec)}</span>
                  )}
                </div>
                <p className="mt-2 text-sm font-medium text-slate-100 group-hover:underline">{v.title}</p>
                {v.locked && <p className="text-xs text-slate-400">Password protected</p>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
