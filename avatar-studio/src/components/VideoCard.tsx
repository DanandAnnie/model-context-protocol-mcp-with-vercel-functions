"use client";
import Link from "next/link";
import { useEffect, useState, type FocusEvent, type PointerEvent } from "react";
import { AtSign, Check, Clock, Copy, Film, LinkIcon, Lock, MessageSquare, Star, Trash2 } from "lucide-react";
import { StatusBadge } from "./ui";
import { CARD_PREVIEW_DELAY_MS, cardPreviewSrc, daysUntilPurge, formatDate, formatSeconds, openCommentsBadge, posterUrl, sendableShareLink, shareExpired, shareExpiresSoon, shareNotYet, shareSummary } from "@/lib/client";
import { REVIEW_LABEL, type Video } from "@/lib/types";

/**
 * The count of review notes on a video no one has resolved yet, beside its title; nothing when there are none. When
 * some of those threads mention the reader (`mentions`), an @ says so, and the label counts them. A dot marks comments
 * new since the reader last opened the video (`fresh`).
 */
function OpenComments({ count, mentions, fresh = false }: { count?: number; mentions?: number; fresh?: boolean }) {
  if (!count) return null;
  const { label, mentions: forYou } = openCommentsBadge(count, mentions, fresh);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${forYou ? "bg-sky-800 text-white" : "bg-sky-50 text-sky-800"}`}
      title={label}
      data-testid="open-comments-badge"
      data-mentions={forYou || undefined}
      data-fresh={fresh || undefined}
    >
      {forYou ? <AtSign className="h-3 w-3" aria-hidden /> : <MessageSquare className="h-3 w-3" aria-hidden />}
      <span aria-hidden>{count}</span>
      {/* A shade that stands out from either badge: darker on the light one, lighter on the dark one. */}
      {fresh && <span aria-hidden className={`ml-0.5 h-1.5 w-1.5 rounded-full ${forYou ? "bg-amber-400" : "bg-amber-700"}`} />}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** What a card's copy button tells the page: a note to announce, and whether the list is out of date. */
export type CardCopyNote = (note: string, stale: boolean) => void;

/**
 * Copies a video's share link from its card, beside (not inside) the card's link. The link is worked out again on the
 * click, so a link that expired while the page stood open is not copied; the page is told what happened (`onNote`), or,
 * without one, the button says it itself. A browser without the clipboard shows the link to copy by hand.
 */
function CopyShareLink({ video, origin, className, onNote }: { video: Video; origin: string; className: string; onNote?: CardCopyNote }) {
  const [copied, setCopied] = useState(false);
  const [own, setOwn] = useState("");
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  const say = (note: string, stale = false) => (onNote ? onNote(note, stale) : setOwn(note));
  async function copy() {
    const link = sendableShareLink(video, origin);
    if (!link) return say(`The link for ${video.title} can no longer be sent; open the video to see why.`, true);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("No clipboard");
      await navigator.clipboard.writeText(link);
      setCopied(true);
      say(`Link for ${video.title} copied`);
    } catch {
      window.prompt("Copy this link", link);
    }
  }
  return (
    <>
      <button type="button" onClick={() => void copy()} aria-label={`Copy link for ${video.title}`} title="Copy the share link" className={className}>
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {!onNote && (
        <span role="status" className="sr-only">
          {own}
        </span>
      )}
    </>
  );
}

const reviewClass = (status: NonNullable<Video["review"]>["status"]) => (status === "approved" ? "bg-emerald-50 text-emerald-800" : status === "changes" ? "bg-amber-50 text-amber-900" : "bg-brand-50 text-brand-800");

/** Whether the system asks for less motion, followed as it changes. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const read = () => setReduced(query.matches);
    read();
    query.addEventListener?.("change", read);
    return () => query.removeEventListener?.("change", read);
  }, []);
  return reduced;
}

/**
 * A finished video's clip, played muted over its card's poster while a mouse rests on the card or the keyboard has
 * brought focus to it, after a moment so a pointer passing over the grid loads nothing; not for a reader who asks the
 * system for less motion. A tap is neither (it would start a clip that plays on until the next tap elsewhere), focus
 * moving within the card (its link to its copy button) keeps the clip going, and the card's element changing (a
 * selection ending, which replaces the focused button without a blur) starts it afresh.
 */
function useCardPreview(src: string | undefined, element: string) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const reduced = useReducedMotion();
  const wanted = !!src && !reduced && (hovered || focused);
  useEffect(() => {
    setHovered(false);
    setFocused(false);
  }, [element]);
  useEffect(() => {
    if (!wanted) return setPreviewing(false);
    const timer = setTimeout(() => setPreviewing(true), CARD_PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [wanted]);
  return {
    previewing: previewing && wanted,
    handlers: {
      onPointerEnter: (e: PointerEvent<HTMLElement>) => e.pointerType === "mouse" && setHovered(true),
      onPointerLeave: () => setHovered(false),
      onFocus: (e: FocusEvent<HTMLElement>) => (e.target as HTMLElement).matches?.(":focus-visible") && setFocused(true),
      onBlur: (e: FocusEvent<HTMLElement>) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false),
    },
  };
}

export function VideoCard({ video, selectable = false, selected = false, onToggle, shareOrigin, onCopyNote, openComments, mentions, freshComments }: { video: Video; selectable?: boolean; selected?: boolean; onToggle?: (shift: boolean) => void; shareOrigin?: string; onCopyNote?: CardCopyNote; openComments?: number; mentions?: number; freshComments?: boolean }) {
  const expiresSoon = shareExpiresSoon(video);
  const previewSrc = cardPreviewSrc(video);
  const { previewing, handlers } = useCardPreview(previewSrc, selectable ? "select" : shareOrigin ? "card" : "link");
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
        {/* Right after the poster, so the badges drawn later stay on top of the clip. It is see-through until it plays,
            so the poster stays while it loads (or if the browser will not play it), and framed as the poster is. */}
        {previewing && (
          <video
            ref={(el) => {
              if (!el) return;
              // Taken off the page, a video keeps downloading until it is collected; stop that at once.
              return () => {
                el.pause();
                el.removeAttribute("src");
                el.load();
              };
            }}
            src={previewSrc}
            poster={posterUrl(video)}
            muted
            loop
            autoPlay
            playsInline
            preload="auto"
            aria-hidden="true"
            data-testid="card-preview"
            style={{ opacity: 0 }}
            className="absolute inset-0 h-full w-full object-cover transition-opacity"
            onPlaying={(e) => (e.currentTarget.style.opacity = "1")}
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
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
          <OpenComments count={openComments} mentions={mentions} fresh={freshComments} />
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
      <button type="button" onClick={(e) => onToggle?.(e.shiftKey)} aria-pressed={selected} aria-label={`Select ${video.title}`} className={`${frame} select-none`} {...handlers}>
        {body}
      </button>
    );
  }
  if (!shareOrigin) {
    return (
      <Link href={`/videos/${video.id}`} className={frame} {...handlers}>
        {body}
      </Link>
    );
  }
  // The same wrapper whether or not the link can be sent, so a poll that changes that does not remount the card.
  return (
    // The preview follows the whole card, so moving onto its copy button (by mouse or by Tab) does not stop the clip.
    <div className="relative h-full" {...handlers}>
      <Link href={`/videos/${video.id}`} className={`${frame} h-full`}>
        {body}
      </Link>
      {sendableShareLink(video, shareOrigin) && (
        <CopyShareLink video={video} origin={shareOrigin} onNote={onCopyNote} className="absolute right-2 top-2 rounded-md bg-white/90 p-1.5 text-slate-700 shadow-sm hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" />
      )}
    </div>
  );
}

/** The exact times behind a row's share summary, for its tooltip. */
function shareTitle(video: Video): string | undefined {
  const times = [video.shareStartsAt && shareNotYet(video) ? `Goes live ${formatDate(video.shareStartsAt)}` : undefined, video.shareExpiresAt ? `${shareExpired(video) ? "Expired" : "Stops working"} ${formatDate(video.shareExpiresAt)}` : undefined].filter(Boolean);
  return times.length ? times.join(" · ") : undefined;
}

/** The library's list layout: one compact row per video, with the card's status, badges, and details in a line. */
export function VideoRow({ video, selectable = false, selected = false, onToggle, shareOrigin, onCopyNote, openComments, mentions, freshComments }: { video: Video; selectable?: boolean; selected?: boolean; onToggle?: (shift: boolean) => void; shareOrigin?: string; onCopyNote?: CardCopyNote; openComments?: number; mentions?: number; freshComments?: boolean }) {
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
          <OpenComments count={openComments} mentions={mentions} fresh={freshComments} />
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
  const shape = "flex w-full items-center gap-3 px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500";
  const frame = `${shape} ${selected ? "bg-brand-50 hover:bg-brand-100" : "bg-white hover:bg-slate-50"}`;
  if (selectable) {
    return (
      <button type="button" onClick={(e) => onToggle?.(e.shiftKey)} aria-pressed={selected} aria-label={`Select ${video.title}`} className={`${frame} select-none`} data-testid="video-row">
        {body}
      </button>
    );
  }
  if (!shareOrigin) {
    return (
      <Link href={`/videos/${video.id}`} className={frame} data-testid="video-row">
        {body}
      </Link>
    );
  }
  // The row's hover is on the whole line, button included, and a row with nothing to copy keeps the button's room, so
  // the status badges line up down the list.
  return (
    <div className="flex items-center bg-white transition hover:bg-slate-50">
      <Link href={`/videos/${video.id}`} className={`${shape} min-w-0 flex-1`} data-testid="video-row">
        {body}
      </Link>
      {sendableShareLink(video, shareOrigin) ? (
        <CopyShareLink video={video} origin={shareOrigin} onNote={onCopyNote} className="mr-2 shrink-0 rounded-md p-1.5 text-slate-600 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" />
      ) : (
        <span className="mr-2 h-[26px] w-[26px] shrink-0" aria-hidden />
      )}
    </div>
  );
}
