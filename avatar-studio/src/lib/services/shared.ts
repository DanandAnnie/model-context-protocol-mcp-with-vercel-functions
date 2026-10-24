// Helpers shared by the service modules.
import { after } from "next/server";
import { NotFoundError } from "../errors";
import { notifyVideoTransition } from "../notifications";
import { LOCAL_OWNER } from "../owner-id";
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
