// How the video page lists review notes; shared by the comments card and its tests.
import type { VideoComment } from "./types";

/** Open notes in the order they were written, then the resolved ones, most recently resolved first. */
export function splitComments<T extends Pick<VideoComment, "resolvedAt">>(comments: T[]): { open: T[]; resolved: T[] } {
  const open = comments.filter((c) => !c.resolvedAt);
  const resolved = comments.filter((c) => c.resolvedAt).sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!));
  return { open, resolved };
}

/** Marks the notes `userId` wrote as `mine`: the ones they can edit and delete. */
export function markMine<T extends Pick<VideoComment, "authorId">>(comments: T[], userId: string): Array<T & { mine: boolean }> {
  return comments.map((c) => ({ ...c, mine: c.authorId === userId }));
}
