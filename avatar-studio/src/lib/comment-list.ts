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

/** Each thread's replies, oldest first, by the id of the note they answer. */
export function repliesByThread<T extends Pick<VideoComment, "parentId" | "createdAt">>(comments: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const c of comments) if (c.parentId) out.set(c.parentId, [...(out.get(c.parentId) ?? []), c]);
  for (const list of out.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

/** Marks the notes `userId` wrote as `mine`: the ones they can edit and delete. */
export function markMine<T extends Pick<VideoComment, "authorId">>(comments: T[], userId: string): Array<T & { mine: boolean }> {
  return comments.map((c) => ({ ...c, mine: c.authorId === userId }));
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
