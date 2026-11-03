// How the video page lists review notes; shared by the comments card and its tests.
import type { VideoComment } from "./types";

/**
 * Open threads in the order they were started, then the resolved ones, most recently resolved first. Only the notes
 * that start a thread are listed here; their replies follow them (see repliesByThread).
 */
export function splitComments<T extends Pick<VideoComment, "id" | "resolvedAt" | "parentId">>(comments: T[]): { open: T[]; resolved: T[] } {
  // A reply whose note is gone is listed on its own, so it can still be seen and deleted.
  const ids = new Set(comments.map((c) => c.id));
  const starts = comments.filter((c) => !c.parentId || !ids.has(c.parentId));
  const open = starts.filter((c) => !c.resolvedAt);
  const resolved = starts.filter((c) => c.resolvedAt).sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!));
  return { open, resolved };
}

/** How the open threads are listed: as they were written, or by the moment in the video each is about. */
export type CommentOrder = "written" | "moment";

/** Where this browser keeps the order chosen for a video's comments. */
export const COMMENT_ORDER_KEY = "avatar-studio:comment-order";

/** The order kept by this browser, read back: by moment only when that was chosen. */
export function commentOrderFrom(stored: string | null): CommentOrder {
  return stored === "moment" ? "moment" : "written";
}

/**
 * Threads in the chosen order. As written keeps the order given. By moment puts the threads pinned to a moment in the
 * video first, earliest moment first, then the notes on the whole video; threads at the same moment, and the notes on
 * the whole video, keep the order given.
 */
export function orderThreads<T extends Pick<VideoComment, "atSec">>(threads: T[], order: CommentOrder): T[] {
  if (order === "written") return threads;
  const at = (c: T) => c.atSec ?? Number.POSITIVE_INFINITY;
  return threads.map((c, i) => ({ c, i })).sort((a, b) => at(a.c) - at(b.c) || a.i - b.i).map(({ c }) => c);
}

/** A mark on the strip along the video: the threads pinned at or just after one moment, where it sits as a percentage. */
export type CommentMarker = { fromSec: number; toSec: number; pct: number; ids: string[] };

/**
 * Marks for the threads pinned to a moment, earliest first, placed along a video `durationSec` long. Threads at the
 * same moment, or closer than `minGapPct` of the length to a mark's first moment, share that mark, so marks stay apart
 * enough to press; a mark's moment is its earliest. A moment past the end sits at the end. Without a length there is nothing to place.
 */
export function commentMarkers<T extends Pick<VideoComment, "id" | "atSec">>(threads: T[], durationSec: number, minGapPct = 2): CommentMarker[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const pinned = orderThreads(threads.filter((c) => c.atSec !== undefined), "moment");
  const out: CommentMarker[] = [];
  for (const c of pinned) {
    const pct = Math.min(100, Math.max(0, (c.atSec! / durationSec) * 100));
    const last = out[out.length - 1];
    if (last && (c.atSec === last.fromSec || pct - last.pct < minGapPct)) {
      last.toSec = c.atSec!;
      last.ids.push(c.id);
    } else out.push({ fromSec: c.atSec!, toSec: c.atSec!, pct, ids: [c.id] });
  }
  return out;
}

/** Where this browser keeps, per reader and video, how far its comments had been read: the newest one written when last opened. */
export const COMMENTS_SEEN_PREFIX = "avatar-studio:comments-seen:";

/** The key for one reader's mark on one video, so people sharing a browser each keep their own. */
export function commentsSeenKey(userId: string, videoId: string): string {
  return `${COMMENTS_SEEN_PREFIX}${userId}:${videoId}`;
}

/** The mark kept for a video with no comments yet: before any could be written, so every later one is new. */
export const NOTHING_SEEN = new Date(0).toISOString();

/**
 * The notes and replies someone else wrote after `seenAt`, the mark kept when the page was last opened. With no mark
 * (a first visit) nothing is new, as nothing has been read before to compare with; the reader's own are never new.
 */
export function newSince<T extends Pick<VideoComment, "id" | "createdAt"> & { mine?: boolean }>(comments: T[], seenAt: string | null): Set<string> {
  const since = seenAt === null ? Number.NaN : Date.parse(seenAt);
  if (Number.isNaN(since)) return new Set();
  return new Set(comments.filter((c) => !c.mine && Date.parse(c.createdAt) > since).map((c) => c.id));
}

/**
 * The mark to keep once the comments are shown: when the newest someone else wrote was written, by the server's clock
 * so a browser's own clock cannot hide or repeat one. The reader's own are passed over, so one stamped just after a
 * teammate's that was saved later cannot hide it. With none, `NOTHING_SEEN`, so the first one written later is new.
 */
export function seenMark(comments: Array<Pick<VideoComment, "createdAt"> & { mine?: boolean }>): string {
  let newest = Number.NEGATIVE_INFINITY;
  for (const c of comments) if (!c.mine) newest = Math.max(newest, Date.parse(c.createdAt) || Number.NEGATIVE_INFINITY);
  return Number.isFinite(newest) ? new Date(newest).toISOString() : NOTHING_SEEN;
}

/** Which open threads are shown in a workspace: all, those naming the reader, or those the reader wrote in. */
export type CommentFilter = "all" | "mentions" | "mine";

/**
 * The threads the filter keeps for the person `userId`: "mentions" those whose note or a reply names them as
 * `@email`, "mine" those whose note or a reply they wrote; "all", or no reader known, keeps every one. The order
 * given is kept.
 */
export function filterThreads<T extends Pick<VideoComment, "id" | "authorId" | "mentions">>(
  threads: T[],
  replies: Map<string, T[]>,
  filter: CommentFilter,
  userId?: string,
): T[] {
  if (filter === "all" || !userId) return threads;
  const keeps = (c: T) => (filter === "mine" ? c.authorId === userId : !!c.mentions?.some((m) => m.userId === userId));
  return threads.filter((t) => keeps(t) || (replies.get(t.id) ?? []).some(keeps));
}

/**
 * Threads as plain text to paste into a chat or an email: a heading with the video's title and how many threads,
 * then each thread numbered in the order given, its moment first when it is pinned to one, and who wrote it, with
 * its replies indented under it. A writer is named by email; one the account mode knows no email for is "you" when
 * it is the person copying, `you` (or there is no one else to be, without `you`), else "a teammate". A note of several
 * lines keeps them, indented past the thread's number, its blank lines left blank.
 */
export function commentsAsText<T extends Pick<VideoComment, "id" | "text" | "atSec" | "authorId" | "authorEmail">>(
  title: string,
  threads: T[],
  replies: Map<string, T[]>,
  formatAt: (sec: number) => string,
  you?: string,
): string {
  const who = (c: T) => c.authorEmail ?? (!you || c.authorId === you ? "you" : "a teammate");
  const block = (lead: string, c: T, indent: string) => {
    const [first, ...rest] = `${c.text} (${who(c)})`.split(/\r?\n/);
    return [`${lead}${first}`, ...rest.map((line) => (line.trim() ? `${indent}${line}` : ""))].join("\n");
  };
  const lines = threads.map((t, i) => {
    const lead = `${i + 1}. ${t.atSec !== undefined ? `[${formatAt(t.atSec)}] ` : ""}`;
    const indent = " ".repeat(`${i + 1}. `.length);
    return [block(lead, t, indent), ...(replies.get(t.id) ?? []).map((r) => block(`${indent}↳ `, r, `${indent}  `))].join("\n");
  });
  const count = `${threads.length} ${threads.length === 1 ? "comment" : "comments"}`;
  return [`Comments on “${title}” (${count})`, "", ...lines].join("\n");
}

/** Each thread's replies, oldest first, by the id of the note they answer. */
export function repliesByThread<T extends Pick<VideoComment, "parentId" | "createdAt">>(comments: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const c of comments) if (c.parentId) out.set(c.parentId, [...(out.get(c.parentId) ?? []), c]);
  for (const list of out.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

/** The reactions a note can have, in the order the page shows them. */
export const COMMENT_REACTIONS = ["👍", "✅", "❤️", "👀", "🎉"] as const;
export type CommentReaction = (typeof COMMENT_REACTIONS)[number];

/** What each reaction is called to a screen reader and in its title. */
export const REACTION_NAMES: Record<CommentReaction, string> = { "👍": "Thumbs up", "✅": "Done", "❤️": "Love", "👀": "Looking", "🎉": "Celebrate" };

/** A reaction as the page shows it: how many gave it, whether the reader did, and who gave it, the reader as "you". */
export type ReactionView = { emoji: CommentReaction; count: number; mine: boolean; by: string[] };

/**
 * A note's reactions for the person `userId`: the ones someone gave, in COMMENT_REACTIONS order. Each names who gave
 * it by email, the reader as "you" (first), and anyone the account mode knows no email for as "a teammate".
 */
export function reactionSummary(c: Pick<VideoComment, "reactions">, userId: string): ReactionView[] {
  return COMMENT_REACTIONS.flatMap((emoji) => {
    const who = c.reactions?.[emoji] ?? [];
    if (!who.length) return [];
    const mine = who.some((r) => r.userId === userId);
    const others = who.filter((r) => r.userId !== userId).map((r) => r.email ?? "a teammate");
    return [{ emoji, count: who.length, mine, by: mine ? ["you", ...others] : others }];
  });
}

/**
 * Marks the notes `userId` wrote as `mine`, the ones they can edit and delete, and gives each its reactions as that
 * person sees them (`reactionList`), so the page can show their own as theirs to take back.
 */
export function markMine<T extends Pick<VideoComment, "authorId" | "reactions">>(comments: T[], userId: string): Array<T & { mine: boolean; reactionList: ReactionView[] }> {
  return comments.map((c) => ({ ...c, mine: c.authorId === userId, reactionList: reactionSummary(c, userId) }));
}

/**
 * The video page's address for a comment's thread: in the workspace it belongs to (`ws`, which switches a member
 * into it), the player at a pinned thread's moment (`t`, whole seconds), and the page scrolled to the thread
 * (`comment`, the note that starts it). Emails and the page's Copy link share it. A personal space's thread names
 * no space: the page never moves a reader out of a workspace on a link's say-so, so it opens in the one they are in.
 */
export function threadLink(origin: string, thread: Pick<VideoComment, "id" | "videoId" | "ownerId" | "atSec">): string {
  // Workspace ids start "ws_" (isWorkspaceId, which lives with server code).
  const params = [
    ...(thread.ownerId.startsWith("ws_") ? [`ws=${encodeURIComponent(thread.ownerId)}`] : []),
    ...(thread.atSec !== undefined ? [`t=${Math.floor(thread.atSec)}`] : []),
    `comment=${encodeURIComponent(thread.id)}`,
  ];
  return `${origin.replace(/\/$/, "")}/videos/${encodeURIComponent(thread.videoId)}?${params.join("&")}`;
}

/** Columns of a video's comments as a spreadsheet (see commentRows). */
export const COMMENT_CSV_COLUMNS = ["thread", "kind", "at", "author", "written", "edited", "status", "resolved_at", "resolved_by", "text"];

/**
 * A video's comments as spreadsheet rows: threads in the order they were started, numbered from 1, each note
 * followed by its replies, oldest first. A reply carries its thread's status; `at` is a pinned note's moment
 * (`1:05`). A reply whose note is gone is a thread of its own, as on the page, and still marked a reply.
 */
export function commentRows(comments: VideoComment[], formatAt: (sec: number) => string): Array<Record<string, string>> {
  const ids = new Set(comments.map((c) => c.id));
  const starts = comments.filter((c) => !c.parentId || !ids.has(c.parentId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const replies = repliesByThread(comments);
  const row = (c: VideoComment, thread: number, start: VideoComment): Record<string, string> => ({
    thread: String(thread),
    // A reply whose note is gone starts its own thread, but is still a reply.
    kind: c.parentId ? "reply" : "note",
    at: c.atSec !== undefined ? formatAt(c.atSec) : "",
    author: c.authorEmail ?? c.authorId,
    written: c.createdAt,
    edited: c.editedAt ?? "",
    status: start.resolvedAt ? "resolved" : "open",
    resolved_at: start.resolvedAt ?? "",
    resolved_by: start.resolvedAt ? (start.resolvedByEmail ?? start.resolvedById ?? "") : "",
    text: c.text,
  });
  return starts.flatMap((start, i) => [row(start, i + 1, start), ...(replies.get(start.id) ?? []).map((r) => row(r, i + 1, start))]);
}
