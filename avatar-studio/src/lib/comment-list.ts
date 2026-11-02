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
