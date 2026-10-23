"use client";
import Link from "next/link";
import { Film, LinkIcon, Lock } from "lucide-react";
import { StatusBadge } from "./ui";
import { formatDate, formatSeconds, posterUrl } from "@/lib/client";
import type { Video } from "@/lib/types";

export function VideoCard({ video, selectable = false, selected = false, onToggle }: { video: Video; selectable?: boolean; selected?: boolean; onToggle?: () => void }) {
  const body = (
    <>
      <div className="relative aspect-video w-full overflow-hidden bg-slate-900">
        {posterUrl(video) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl(video)} alt="" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-500">
            <Film className="h-8 w-8" />
          </div>
        )}
        <span className="absolute left-2 top-2">
          <StatusBadge status={video.status} />
        </span>
        {selectable && (
          <span className={`absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border-2 ${selected ? "border-brand-600 bg-brand-600 text-white" : "border-white/80 bg-black/40"}`} aria-hidden>
            {selected && (
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M3 8.5l3 3 7-7" />
              </svg>
            )}
          </span>
        )}
        {video.durationSec != null && (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">{formatSeconds(video.durationSec)}</span>
        )}
        {(video.shareDisabled || video.shareLocked) && (
          <span className="absolute bottom-2 left-2 flex gap-1" data-testid="share-badges">
            {video.shareDisabled && (
              <span className="inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white" title="The share link is off">
                <LinkIcon className="h-3 w-3" /> Link off
              </span>
            )}
            {video.shareLocked && (
              <span className="inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white" title="Visitors need a password">
                <Lock className="h-3 w-3" /> Password
              </span>
            )}
          </span>
        )}
      </div>
      <div className="p-3">
        <div className="truncate text-sm font-medium text-slate-900">{video.title}</div>
        <div className="mt-0.5 text-xs text-slate-500">
          {video.aspect} · {formatDate(video.createdAt)}{video.batchId ? " · batch" : ""}{video.folder ? ` · ${video.folder}` : ""}{video.views ? ` · ${video.views} ${video.views === 1 ? "view" : "views"}` : ""}
        </div>
      </div>
    </>
  );
  const frame = `group block w-full overflow-hidden rounded-xl border bg-white text-left transition hover:shadow-sm ${selected ? "border-brand-500 ring-2 ring-brand-100" : "border-slate-200 hover:border-slate-300"}`;
  if (selectable) {
    return (
      <button type="button" onClick={onToggle} aria-pressed={selected} aria-label={`Select ${video.title}`} className={frame}>
        {body}
      </button>
    );
  }
  return (
    <Link href={`/videos/${video.id}`} className={frame}>
      {body}
    </Link>
  );
}
