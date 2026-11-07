"use client";
import Link from "next/link";
import { Play } from "lucide-react";
import { noteFolderVisit } from "@/lib/folder-visit";
import { notePlayOnArrival } from "./ShareUpNext";

/**
 * Play all, on a shared folder's page: opens the video it is given (the first listed one a visitor can watch without a
 * password) playing, and each video's "Up next" countdown carries the viewer through the rest in the page's order. A
 * link, so it opens in a new tab or window as any link does; only a plain click is told to start playing, and it moves
 * within the page (no full reload), so the browser still counts the click as the viewer's when the video starts.
 */
export function CollectionPlayAll({ collectionId, firstId, count }: { collectionId: string; firstId: string; count: number }) {
  return (
    <Link
      href={`/share/${encodeURIComponent(firstId)}`}
      aria-label={`Play all ${count} videos`}
      onClick={(e) => {
        // A click that opens elsewhere (a modified click) leaves this tab where it is, so nothing is noted.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        noteFolderVisit(collectionId);
        notePlayOnArrival(firstId);
      }}
      className="inline-flex items-center gap-2 rounded-lg border border-slate-500 px-4 py-2.5 text-sm font-medium text-slate-100 hover:border-slate-300 hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      data-testid="collection-play-all"
    >
      <Play className="h-4 w-4" aria-hidden />
      Play all
    </Link>
  );
}
