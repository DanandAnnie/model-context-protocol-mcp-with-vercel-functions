"use client";
import Link from "next/link";
import { Clock, Film, LinkIcon, Lock, Star, Trash2 } from "lucide-react";
import { StatusBadge } from "./ui";
import { daysUntilPurge, formatDate, formatSeconds, posterUrl, shareExpired, shareExpiresSoon, shareNotYet, shareSummary } from "@/lib/client";
import { REVIEW_LABEL, type Video } from "@/lib/types";

const reviewClass = (status: NonNullable<Video["review"]>["status"]) => (status === "approved" ? "bg-emerald-50 text-emerald-800" : status === "changes" ? "bg-amber-50 text-amber-900" : "bg-brand-50 text-brand-800");

export function VideoCard({ video, selectable = false, selected = false, onToggle }: { video: Video; selectable?: boolean; selected?: boolean; onToggle?: (shift: boolean) => void }) {
  const expiresSoon = shareExpiresSoon(video);
  const body = (
    <>
      <div className="relative aspect-video w-full overflow-hidden bg-slate-900">
        {posterUrl(video) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl(video)} alt="" loading="lazy" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-500">
            <Film className="h-8 w-8" />
          </div>
        )}
        <span className="absolute left-2 top-2 flex flex-wrap gap-1">
          <StatusBadge status={video.status} />
          {video.agentWaiting && video.status === "processing" && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">Waiting for your review</span>}
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
        {video.deletedAt && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded bg-rose-700/90 px-1.5 py-0.5 text-xs text-white" data-testid="trash-badge" title={`Moved to the trash ${formatDate(video.deletedAt)}`}>
            <Trash2 className="h-3 w-3" /> {daysUntilPurge(video) === 0 ? "Deleted today" : `${daysUntilPurge(video)} ${daysUntilPurge(video) === 1 ? "day" : "days"} left`}
          </span>
        )}
        {!video.deletedAt && (video.shareDisabled || video.shareLocked || shareExpired(video) || shareNotYet(video) || expiresSoon) && (
          // Wraps rather than running under the duration in the opposite corner on a narrow card.
          <span className="absolute bottom-2 left-2 flex max-w-[calc(100%-4rem)] flex-wrap gap-1" data-testid="share-badges">
            {video.shareDisabled && (
              <span className="inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white" title="The share link is off">
                <LinkIcon className="h-3 w-3" /> Link off
              </span>
            )}
            {!video.shareDisabled && shareExpired(video) && (
              <span className="inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white" title={`The share link expired ${formatDate(video.shareExpiresAt!)}`}>
                <Clock className="h-3 w-3" /> Expired
              </span>
            )}
            {!video.shareDisabled && !shareExpired(video) && shareNotYet(video) && (
              <span className="inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white" title={`The share link goes live ${formatDate(video.shareStartsAt!)}`}>
                <Clock className="h-3 w-3" /> Scheduled
              </span>
            )}
            {expiresSoon && (
              <span className="inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white" title={`The share link stops working ${formatDate(video.shareExpiresAt!)}`}>
                <Clock className="h-3 w-3" /> {expiresSoon}
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
        <div className="flex items-center gap-2">
          {video.starred && (
            <span className="shrink-0" title="Starred" data-testid="star-badge">
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" aria-hidden />
              <span className="sr-only">Starred</span>
            </span>
          )}
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{video.title}</div>
          {video.review && (
            <span
              data-testid="review-badge"
              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${reviewClass(video.review.status)}`}
            >
              {REVIEW_LABEL[video.review.status]}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-slate-500">
          {video.aspect} · {formatDate(video.createdAt)}{video.batchId ? " · batch" : ""}{video.folder ? ` · ${video.folder}` : ""}{video.views ? ` · ${video.views} ${video.views === 1 ? "view" : "views"}` : ""}
        </div>
      </div>
    </>
  );
  const frame = `group block w-full overflow-hidden rounded-xl border bg-white text-left transition hover:shadow-sm ${selected ? "border-brand-500 ring-2 ring-brand-100" : "border-slate-200 hover:border-slate-300"}`;
  if (selectable) {
    return (
      // Shift+click picks a run of cards; select-none keeps a browser that extends a text selection on Shift+click from
      // also selecting the text between them (Chromium does not).
      <button type="button" onClick={(e) => onToggle?.(e.shiftKey)} aria-pressed={selected} aria-label={`Select ${video.title}`} className={`${frame} select-none`}>
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

/** The exact times behind a row's share summary, for its tooltip. */
function shareTitle(video: Video): string | undefined {
  const times = [video.shareStartsAt && shareNotYet(video) ? `Goes live ${formatDate(video.shareStartsAt)}` : undefined, video.shareExpiresAt ? `${shareExpired(video) ? "Expired" : "Stops working"} ${formatDate(video.shareExpiresAt)}` : undefined].filter(Boolean);
  return times.length ? times.join(" · ") : undefined;
}

/** The library's list layout: one compact row per video, with the card's status, badges, and details in a line. */
export function VideoRow({ video, selectable = false, selected = false, onToggle }: { video: Video; selectable?: boolean; selected?: boolean; onToggle?: (shift: boolean) => void }) {
  const share = shareSummary(video);
  const body = (
    <>
      {selectable && (
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 ${selected ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white"}`} aria-hidden>
          {selected && (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M3 8.5l3 3 7-7" />
            </svg>
          )}
        </span>
      )}
      <span className="relative hidden aspect-video w-24 shrink-0 overflow-hidden rounded bg-slate-900 sm:block">
        {posterUrl(video) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl(video)} alt="" loading="lazy" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-slate-500">
            <Film className="h-5 w-5" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {video.starred && (
            <span className="shrink-0" title="Starred" data-testid="star-badge">
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" aria-hidden />
              <span className="sr-only">Starred</span>
            </span>
          )}
          <span className="truncate text-sm font-medium text-slate-900">{video.title}</span>
          {video.review && (
            <span data-testid="review-badge" className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${reviewClass(video.review.status)}`}>
              {REVIEW_LABEL[video.review.status]}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-slate-500">
          {video.aspect} · {formatDate(video.createdAt)}
          {video.durationSec != null ? ` · ${formatSeconds(video.durationSec)}` : ""}
          {video.folder ? ` · ${video.folder}` : ""}
          {video.batchId ? " · batch" : ""}
          {video.views ? ` · ${video.views} ${video.views === 1 ? "view" : "views"}` : ""}
        </span>
      </span>
      {/* Shown at every width (it says why a link filter matched), cut short rather than pushing the status off. */}
      {share && (
        <span className="max-w-[35%] shrink truncate text-xs text-slate-600" data-testid="row-share" title={shareTitle(video)}>
          {share}
        </span>
      )}
      {video.deletedAt && (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-rose-800" data-testid="trash-badge" title={`Moved to the trash ${formatDate(video.deletedAt)}`}>
          <Trash2 className="h-3 w-3" aria-hidden /> {daysUntilPurge(video) === 0 ? "Deleted today" : `${daysUntilPurge(video)} ${daysUntilPurge(video) === 1 ? "day" : "days"} left`}
        </span>
      )}
      <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {video.agentWaiting && video.status === "processing" && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">Waiting for your review</span>}
        <StatusBadge status={video.status} />
      </span>
    </>
  );
  // The ring is drawn inside, since the list's rounded border clips anything outside a row.
  const frame = `flex w-full items-center gap-3 px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${selected ? "bg-brand-50 hover:bg-brand-100" : "bg-white hover:bg-slate-50"}`;
  if (selectable) {
    return (
      <button type="button" onClick={(e) => onToggle?.(e.shiftKey)} aria-pressed={selected} aria-label={`Select ${video.title}`} className={`${frame} select-none`} data-testid="video-row">
        {body}
      </button>
    );
  }
  return (
    <Link href={`/videos/${video.id}`} className={frame} data-testid="video-row">
      {body}
    </Link>
  );
}
