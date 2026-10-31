// Helpers shared by the service modules.
import { z } from "zod";
import { after } from "next/server";
import { ConflictError, NotFoundError } from "../errors";
import { notifyVideoTransition } from "../notifications";
import { LOCAL_OWNER } from "../owner-id";
import { getStore, type ItemKind } from "../store";
import type { Video } from "../types";

/** Pass as the owner to skip the ownership check (public share pages). */
export const PUBLIC_ACCESS = null;

/** Throws NotFound when an item belongs to a different owner (missing ownerId counts as local). */
export function owned<T extends { ownerId?: string }>(item: T | null, ownerId: string | null, what: string): T {
  if (!item) throw new NotFoundError(`${what} not found`);
  if (ownerId !== PUBLIC_ACCESS && (item.ownerId ?? LOCAL_OWNER) !== ownerId) throw new NotFoundError(`${what} not found`);
  return item;
}

/** Provider list calls (avatars, voices) are memoised for this long. */
export const LIST_TTL_MS = 5 * 60 * 1000;

/**
 * Deliver the owner's webhook after the response is sent, so a status poll never waits on a
 * third-party endpoint. Outside a request (tests, scripts) the delivery runs inline.
 */
export async function scheduleNotification(prev: Video, next: Video): Promise<void> {
  await afterResponse(() => notifyVideoTransition(prev, next));
}

/** Runs work after the response is sent (Next's after()); inline when there is no request scope. */
export async function afterResponse(work: () => Promise<unknown>): Promise<void> {
  const run = () => work().catch((err) => console.error("deferred work failed:", err));
  try {
    after(run);
  } catch {
    await run();
  }
}

export function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** The kinds of renderer jobs that carry a title (or, for an instant voice, a name) the account can change. */
export type RenamableKind = Extract<ItemKind, "footage" | "shoot" | "cleanup" | "lipsync" | "music" | "voicechange" | "instantvoice">;

/** The kinds whose retried start is compared on the title it was started with (cleanups and lip syncs are not). */
const TITLE_COMPARED: ReadonlySet<RenamableKind> = new Set(["footage", "shoot", "music", "voicechange"]);

/** A new name for a generated clip, photo shoot, cleanup, lip sync, video with music, or recording: 1 to 120 characters, trimmed. */
export const jobRenameSchema = z.object({ title: z.string("A title is text").trim().min(1, "Give it a name").max(120, "A title is at most 120 characters") });

/**
 * Renames one of the owner's renderer jobs (a generated clip, photo shoot, cleanup, lip sync, video with music, or
 * recording in a voice). The name it was started with is kept (server only) where a retried start with the same key is
 * compared on it, so the retry is still recognised. The write is conditional on the row read and read again on a miss,
 * so a status change landing meanwhile is kept and a delete meanwhile stays a delete.
 */
export async function renameJob<T extends { id: string; ownerId: string; title: string; askedTitle?: string; updatedAt: string }>(kind: RenamableKind, id: string, title: string, ownerId: string, what: string): Promise<T> {
  let current = owned(await getStore().get<T>(kind, id), ownerId, what);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (current.title === title) return current;
    const next: T = { ...current, title, ...(TITLE_COMPARED.has(kind) ? { askedTitle: current.askedTitle ?? current.title } : {}), updatedAt: nextUpdatedAt(current.updatedAt) };
    if (await getStore().putIf(kind, next, "updatedAt", current.updatedAt)) return next;
    current = owned(await getStore().get<T>(kind, id), ownerId, what);
  }
  throw new ConflictError(`The ${what.toLowerCase()} kept changing while it was being renamed; try again`);
}

/** A time after `previous` and no earlier than now, so a conditional write over the row always sees it move. */
export function nextUpdatedAt(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

/**
 * Stores what the renderer said about a job (`apply` builds the row from the latest one read). The write is
 * conditional on that row and always moves its time on, so a rename landing meanwhile is read again and kept rather
 * than undone, and the renewal is not lost to it either; a later answer another check stored meanwhile is kept as it is.
 * A row deleted meanwhile stays deleted: `job` is returned as it was.
 */
export async function writeRefresh<T extends { id: string; updatedAt: string; checkedAt?: string }>(kind: RenamableKind, job: T, apply: (current: T) => T): Promise<T> {
  let current: T | null = job;
  for (let attempt = 0; attempt < 3 && current; attempt++) {
    const next = { ...apply(current), updatedAt: nextUpdatedAt(current.updatedAt) };
    // Another check (another server, say) stored a later answer meanwhile: it stands, rather than this one undoing it.
    if (current !== job && current.checkedAt !== job.checkedAt && (current.checkedAt ?? "") >= (next.checkedAt ?? "")) return current;
    if (await getStore().putIf(kind, next, "updatedAt", current.updatedAt)) return next;
    current = await getStore().get<T>(kind, job.id);
  }
  return current ?? job;
}
