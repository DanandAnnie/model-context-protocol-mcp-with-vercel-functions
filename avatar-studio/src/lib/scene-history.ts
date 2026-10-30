// Undo and redo for the editor's scene changes (a scene added, removed, moved, duplicated, split, or merged; scenes
// imported). Typing is left to the text box's own undo. Pure, so the editor and the tests share it.

/** The most changes kept to undo; the oldest goes first. */
export const MAX_HISTORY = 50;

export interface HistoryEntry<T> {
  /** What was done, as the Undo and Redo buttons name it ("remove scene 3"). */
  label: string;
  before: T;
  after: T;
}

export interface History<T> {
  past: HistoryEntry<T>[];
  future: HistoryEntry<T>[];
}

export const emptyHistory = <T>(): History<T> => ({ past: [], future: [] });

/** The history with a change recorded: it can be undone, and anything undone before it can no longer be redone. */
export function record<T>(history: History<T>, entry: HistoryEntry<T>): History<T> {
  return { past: [...history.past, entry].slice(-MAX_HISTORY), future: [] };
}

/** Whether two states are the same; by identity unless the caller says otherwise (the editor replaces rather than changes its scenes). */
export type Same<T> = (a: T, b: T) => boolean;
const identical = <T>(a: T, b: T) => a === b;

/**
 * Undoes the last change: the state to go back to, and whether the state has changed since that change was made (typing,
 * say), which undoing also takes back. What it takes back is kept: redoing the change returns the state as it was
 * just before the undo, later edits included. Null when there is nothing to undo.
 */
export function undo<T>(history: History<T>, current: T, same: Same<T> = identical): { history: History<T>; state: T; entry: HistoryEntry<T>; changedSince: boolean } | null {
  const entry = history.past[history.past.length - 1];
  if (!entry) return null;
  const changedSince = !same(current, entry.after);
  const kept = changedSince ? { ...entry, after: current } : entry;
  return { history: { past: history.past.slice(0, -1), future: [...history.future, kept] }, state: entry.before, entry, changedSince };
}

/** Redoes the last change undone, as `undo` does the other way: what the redo replaces can be had back by undoing it. */
export function redo<T>(history: History<T>, current: T, same: Same<T> = identical): { history: History<T>; state: T; entry: HistoryEntry<T>; changedSince: boolean } | null {
  const entry = history.future[history.future.length - 1];
  if (!entry) return null;
  const changedSince = !same(current, entry.before);
  const kept = changedSince ? { ...entry, before: current } : entry;
  return { history: { past: [...history.past, kept], future: history.future.slice(0, -1) }, state: entry.after, entry, changedSince };
}
