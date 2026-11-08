"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, AtSign, BellDot, Camera, ClipboardCheck, Clapperboard, Clock, FilePenLine, Gauge, Languages, Layers3, LayoutTemplate, MessageSquare, Sparkles, TimerOff, Wand2 } from "lucide-react";
import { Insights } from "@/components/Insights";
import { SharedFolderOpens } from "@/components/SharedFolderOpens";
import type { FolderOpensInput } from "@/lib/insights";
import { VideoCard } from "@/components/VideoCard";
import { EmptyState, SectionTitle, Skeleton } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useWorkspaceRole } from "@/hooks/useCanEdit";
import { allowanceNotice, awaitingReview, failedThisWeek, openCommentSummary, shareAttention } from "@/lib/client";
import { ACTIVITY_SEEN_PREFIX, activitySeenKey, newActivityCount, newActivityIds, newActivityLine } from "@/lib/activity-text";
import { COMMENTS_SEEN_PREFIX, freshVideoIds, markCommentsSeen, readSeenMark } from "@/lib/comment-list";
import { draftKeyFor, draftSummary, type DraftSummary } from "@/lib/editor-draft";
import type { ActivityEvent, Video } from "@/lib/types";

const QUICK = [
  { href: "/create", icon: Clapperboard, title: "Avatar video", body: "Script + avatar + voice. The core workflow.", accent: "bg-brand-600" },
  { href: "/agent", icon: Sparkles, title: "Video Agent", body: "Describe a video in a sentence; the agent plans the scenes and makes it.", accent: "bg-indigo-600" },
  { href: "/create?writer=1", icon: Wand2, title: "Write with AI", body: "Generate a script from a topic, then render it.", accent: "bg-violet-600" },
  { href: "/templates", icon: LayoutTemplate, title: "Start from a template", body: "Listing walkthroughs, welcomes, tips, and more.", accent: "bg-amber-500" },
  { href: "/batch", icon: Layers3, title: "Personalize at scale", body: "One script, a CSV of recipients, one video each.", accent: "bg-rose-600" },
  { href: "/avatars?new=1", icon: Camera, title: "Photo avatar", body: "Turn a portrait into a presenter.", accent: "bg-sky-600" },
  { href: "/translate", icon: Languages, title: "Translate a video", body: "Dub an existing video into another language.", accent: "bg-emerald-600" },
  { href: "/interactive", icon: MessageSquare, title: "Interactive avatar", body: "Talk to a presenter live; it answers in character.", accent: "bg-slate-800" },
];

export default function HomePage() {
  const { data, loading } = useApi<{ videos: Video[]; shareOrigin?: string; openComments?: Record<string, number>; mentions?: Record<string, number>; latestComment?: Record<string, string>; latestAnyComment?: Record<string, string>; you?: string }>("/api/videos");
  const recent = data?.videos.slice(0, 4) ?? [];
  // Shared folders' opens by day, for the Insights card that names the folders opened most.
  const { data: shares } = useApi<{ collections: FolderOpensInput[] }>("/api/collections");
  // This month's renders against the plan's allowance, once little or none of it is left.
  const { data: status } = useApi<{ renderLimitPerMonth?: number | null; usage?: { rendersThisMonth: number } }>("/api/status");
  const space = useWorkspaceRole();
  const role = space?.role;
  // The editor's unsent draft for the space being worked in, as this browser keeps it (another tab's edits included).
  const draftKey = space ? draftKeyFor({ personalId: space.userId, activeId: space.workspaceId ?? space.userId }) : null;
  const [draft, setDraft] = useState<{ key: string; summary: DraftSummary } | null>(null);
  useEffect(() => {
    if (!draftKey) return;
    const read = () => {
      let summary: DraftSummary | null = null;
      try {
        summary = draftSummary(window.localStorage.getItem(draftKey));
      } catch {
        // Storage can be unavailable (private mode); drafts are a convenience only.
      }
      setDraft(summary ? { key: draftKey, summary } : null);
    };
    read();
    const onStorage = (e: StorageEvent) => (e.key === draftKey || e.key === null) && read();
    // A tab brought back from the browser's page cache, or frozen while in the background, can miss those events.
    const onShow = () => document.visibilityState === "visible" && read();
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", read);
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", read);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [draftKey]);
  // Only the draft of the space shown now: a switch of space never shows the last one's for a moment.
  const shownDraft = draft && draft.key === draftKey && role !== "viewer" ? draft.summary : null;
  // Said once the card has gone, and where the keyboard goes then: the first quick action, not the top of the page.
  const [draftNote, setDraftNote] = useState("");
  const quickRef = useRef<HTMLDivElement>(null);
  function discardDraft() {
    if (!draft) return;
    const name = draft.summary.title ? ` “${draft.summary.title}”` : "";
    // An editor still open in another tab holds its own copy, and saves it again at its next change.
    if (!window.confirm(`Discard your unsent draft${name}? It is kept only in this browser, so it cannot be brought back; an editor still open in another tab keeps its copy.`)) return;
    try {
      window.localStorage.removeItem(draft.key);
    } catch {
      // Nothing was kept to remove.
    }
    setDraft(null);
    setDraftNote("Draft discarded.");
    requestAnimationFrame(() => quickRef.current?.querySelector<HTMLAnchorElement>("a")?.focus());
  }
  // A workspace's viewers make no renders, so the allowance is not theirs to watch.
  const allowance = status?.usage && role !== "viewer" ? allowanceNotice(status.usage.rendersThisMonth, status.renderLimitPerMonth) : undefined;
  // Only a workspace's owners decide a review; everyone else is told whose decision it waits on.
  const decides = role === "owner";
  // Videos waiting for a review decision, this week's failed renders, and links about to lapse or lapsed and still
  // handed out; each line opens the library filtered to those videos.
  const attention = data ? { ...shareAttention(data.videos), failed: failedThisWeek(data.videos), review: awaitingReview(data.videos) } : { expiring: 0, expired: 0, failed: 0, review: 0 };
  // Review notes no one has resolved yet, across the library (Home asks for every video, so the counts are for all of them).
  const comments = openCommentSummary(data?.openComments);
  // Of those, the open threads that name the reader: what is waiting on them in particular.
  const forYou = openCommentSummary(data?.mentions);
  // The videos a teammate wrote in since the reader last opened them in this browser, newest first; the first three by name.
  // Read again when a video page in another tab keeps a mark, and when this tab comes back to the front.
  const [marksTick, setMarksTick] = useState(0);
  useEffect(() => {
    const bump = () => setMarksTick((n) => n + 1);
    const onStorage = (e: StorageEvent) => (e.key === null || e.key.startsWith(COMMENTS_SEEN_PREFIX) || e.key.startsWith(ACTIVITY_SEEN_PREFIX)) && bump();
    const onShow = () => document.visibilityState === "visible" && bump();
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", bump);
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", bump);
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, []);
  const fresh = useMemo(() => {
    const byId = new Map((data?.videos ?? []).map((v) => [v.id, v]));
    return freshVideoIds(data?.latestComment, data?.you, readSeenMark).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    // marksTick: read the marks again; the data alone does not change when one is kept.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, marksTick]);
  // In a workspace, what teammates did since the reader last saw its whole Activity feed in this browser (the mark the
  // Workspace page keeps); Home only reads the mark, so the badges are still there when the feed is opened.
  const workspaceId = space?.workspaceId ?? null;
  const feed = useApi<{ events: ActivityEvent[] }>(workspaceId ? "/api/activity?limit=30&links=0" : null);
  // Asked again when the tab comes back to the front, so updates made meanwhile are counted.
  const refetchFeed = feed.refetch;
  useEffect(() => {
    if (!workspaceId) return;
    const again = () => document.visibilityState === "visible" && void refetchFeed();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [workspaceId, refetchFeed]);
  const newActivity = useMemo(() => {
    if (!workspaceId || !space || !feed.data) return "";
    const fresh = newActivityIds(feed.data.events, readSeenMark(activitySeenKey(space.userId, workspaceId)), space.userId);
    return newActivityCount(fresh.size, feed.data.events.length, 30);
    // marksTick: read the mark again when the feed is shown in another tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.data, workspaceId, space?.userId, marksTick]);
  // Marks every one of them read here, as opening each would, then says so where the line was.
  const [freshNote, setFreshNote] = useState("");
  function markFreshRead() {
    if (!data?.you || !data.latestComment) return;
    // The mark opening each video keeps: its newest comment by others in any thread, not only the open ones listed here.
    const marks = { ...data.latestComment, ...data.latestAnyComment };
    const kept = markCommentsSeen(fresh.map((v) => v.id), marks, data.you, (key, value) => window.localStorage.setItem(key, value), readSeenMark);
    setMarksTick((n) => n + 1);
    // Cleared first, so the same words a second time are still spoken.
    setFreshNote("");
    const note = kept ? `Marked ${kept === 1 ? "1 video's" : `${kept} videos'`} comments as read.` : "Could not mark them as read in this browser.";
    requestAnimationFrame(() => {
      setFreshNote(note);
      // The line goes once every one is marked, so the keyboard moves on; while some are left, it stays on the button.
      if (kept === fresh.length) quickRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    });
  }

  return (
    <>
      <SectionTitle title="Home" subtitle="What do you want to make today?" />

      {(allowance || attention.expiring > 0 || attention.expired > 0 || attention.failed > 0 || attention.review > 0 || comments.videos > 0 || forYou.videos > 0 || fresh.length > 0 || newActivity !== "") && (
        <section aria-label="Things to check" data-testid="home-attention" className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <ul className="space-y-1.5">
            {allowance && (
              <li className="flex flex-wrap items-center gap-x-2" data-testid="allowance-notice">
                <Gauge className="h-4 w-4 shrink-0" />
                <span>
                  {allowance.left === 0
                    ? `This month's renders are used up (${allowance.used} of ${allowance.limit}); renders can start again on ${new Date(allowance.resetsAt).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" })} (UTC).`
                    : `${allowance.left === 1 ? "1 render" : `${allowance.left} renders`} left this month (${allowance.used} of ${allowance.limit} used).`}
                </span>
                <Link href="/settings" className="font-medium underline hover:no-underline">
                  See plan and usage
                </Link>
              </li>
            )}
            {attention.review > 0 && (
              <li className="flex flex-wrap items-center gap-x-2">
                <ClipboardCheck className="h-4 w-4 shrink-0" />
                <span>
                  {attention.review === 1 ? "1 video is waiting for " : `${attention.review} videos are waiting for `}
                  {decides ? "your review" : "an owner's review"}.
                </span>
                <Link href="/videos?review=pending" className="font-medium underline hover:no-underline">
                  Show videos in review
                </Link>
              </li>
            )}
            {fresh.length > 0 && (
              <li className="flex flex-wrap items-center gap-x-2" data-testid="fresh-comments-notice">
                <BellDot className="h-4 w-4 shrink-0" />
                <span>
                  New comments since you last looked, on{" "}
                  {fresh.slice(0, 3).map((v, i, shown) => (
                    <span key={v.id}>
                      <Link href={`/videos/${v.id}`} className="break-words font-medium underline hover:no-underline">
                        {v.title}
                        <span className="sr-only"> (new comments)</span>
                      </Link>
                      {i < shown.length - 1 ? (i === shown.length - 2 && fresh.length <= 3 ? " and " : ", ") : ""}
                    </span>
                  ))}
                  {fresh.length > 3 && (
                    <>
                      {" and "}
                      <Link href="/videos?comments=open" className="font-medium underline hover:no-underline">
                        {fresh.length - 3} {fresh.length - 3 === 1 ? "other video" : "other videos"}
                      </Link>
                    </>
                  )}
                  .
                </span>
                <button type="button" onClick={markFreshRead} aria-label="Mark the new comments on these videos as read" className="font-medium underline hover:no-underline">
                  Mark as read
                </button>
              </li>
            )}
            {newActivity !== "" && (
              <li className="flex flex-wrap items-center gap-x-2" data-testid="new-activity-notice">
                <Activity className="h-4 w-4 shrink-0" />
                <span>{newActivityLine(newActivity)}.</span>
                <Link href="/workspace#activity" className="font-medium underline hover:no-underline">
                  Open activity
                </Link>
              </li>
            )}
            {forYou.videos > 0 && (
              <li className="flex flex-wrap items-center gap-x-2" data-testid="mentions-notice">
                <AtSign className="h-4 w-4 shrink-0" />
                <span>
                  {forYou.notes === 1 ? "1 open comment mentions" : `${forYou.notes} open comments mention`} you, on {forYou.videos === 1 ? "1 video" : `${forYou.videos} videos`}.
                </span>
                <Link href="/videos?comments=mentions" className="font-medium underline hover:no-underline">
                  Show videos that mention you
                </Link>
              </li>
            )}
            {comments.videos > 0 && (
              <li className="flex flex-wrap items-center gap-x-2" data-testid="open-comments-notice">
                <MessageSquare className="h-4 w-4 shrink-0" />
                <span>
                  {comments.notes === 1 ? "1 comment" : `${comments.notes} comments`} on {comments.videos === 1 ? "1 video" : `${comments.videos} videos`} {comments.notes === 1 ? "is" : "are"} not resolved yet.
                </span>
                <Link href="/videos?comments=open" className="font-medium underline hover:no-underline">
                  Show videos with open comments
                </Link>
              </li>
            )}
            {attention.failed > 0 && (
              <li className="flex flex-wrap items-center gap-x-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{attention.failed === 1 ? "1 render made in the last 7 days failed and has not been retried" : `${attention.failed} renders made in the last 7 days failed and have not been retried`}.</span>
                <Link href="/videos?status=failed&created=7d" className="font-medium underline hover:no-underline">
                  Show failed renders
                </Link>
              </li>
            )}
            {attention.expiring > 0 && (
              <li className="flex flex-wrap items-center gap-x-2">
                <Clock className="h-4 w-4 shrink-0" />
                <span>{attention.expiring === 1 ? "1 share link expires" : `${attention.expiring} share links expire`} within a week.</span>
                <Link href="/videos?share=expiring" className="font-medium underline hover:no-underline">
                  Show expiring links
                </Link>
              </li>
            )}
            {attention.expired > 0 && (
              <li className="flex flex-wrap items-center gap-x-2">
                <TimerOff className="h-4 w-4 shrink-0" />
                <span>{attention.expired === 1 ? "1 share link has expired but is still on: visitors see that it has expired" : `${attention.expired} share links have expired but are still on: visitors see that they have expired`}.</span>
                <Link href="/videos?share=expired" className="font-medium underline hover:no-underline">
                  Show expired links
                </Link>
              </li>
            )}
          </ul>
        </section>
      )}

      {shownDraft && (
        <section aria-label="Your unsent draft" data-testid="home-draft" className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <FilePenLine className="h-5 w-5 shrink-0 text-brand-600" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-900">Continue your draft: {shownDraft.title || "Untitled video"}</p>
            <p className="text-xs text-slate-500">
              {shownDraft.scenes === 1 ? "1 scene" : `${shownDraft.scenes} scenes`}, {shownDraft.words === 1 ? "1 word" : `${shownDraft.words.toLocaleString()} words`}
              {shownDraft.savedAt && `, saved ${new Date(shownDraft.savedAt).toLocaleString()}`}
            </p>
            {shownDraft.opening && <p className="mt-0.5 truncate text-xs italic text-slate-600">“{shownDraft.opening}”</p>}
          </div>
          <Link href="/create" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
            Continue editing
          </Link>
          <button type="button" onClick={discardDraft} className="rounded-lg px-2 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-rose-700">
            Discard draft
          </button>
        </section>
      )}

      <p role="status" className="sr-only">
        {draftNote}
        {draftNote && freshNote ? " " : ""}
        {freshNote}
      </p>

      {/* Set once the workspace's activity has been read, so a check can tell "nothing new" from "not read yet". */}
      <div ref={quickRef} data-activity-checked={workspaceId && feed.data ? "true" : undefined} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {QUICK.map(({ href, icon: Icon, title, body, accent }) => (
          <Link key={title} href={href} className="rounded-xl border border-slate-200 bg-white p-5 transition hover:border-slate-300 hover:shadow-sm">
            <span className={`flex h-10 w-10 items-center justify-center rounded-lg text-white ${accent}`}>
              <Icon className="h-5 w-5" />
            </span>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">{title}</h3>
            <p className="mt-1 text-xs text-slate-500">{body}</p>
          </Link>
        ))}
      </div>

      {data && data.videos.length > 0 && (
        <div className="mt-10">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">Insights</h2>
          <Insights videos={data.videos} />
          {!!shares?.collections.length && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <SharedFolderOpens collections={shares.collections} />
            </div>
          )}
        </div>
      )}

      <div className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Recent videos</h2>
          <Link href="/videos" className="text-sm font-medium text-brand-600 hover:underline">
            View all
          </Link>
        </div>
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="aspect-[16/11]" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <EmptyState
            icon={<Clapperboard className="h-8 w-8" />}
            title="No videos yet"
            body="Create your first avatar video. It takes about a minute."
            action={
              <Link href="/create" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
                Create video
              </Link>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {recent.map((v) => (
              <VideoCard key={v.id} video={v} shareOrigin={data?.shareOrigin} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
