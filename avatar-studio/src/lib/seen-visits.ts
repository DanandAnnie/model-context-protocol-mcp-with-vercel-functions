import type { Agent } from "./types";

/**
 * What one browser remembers of the visits it has shown, for the "New visits" mark on the Interactive page. Times are the
 * server's own (`Agent.lastVisitAt`, a visit's `startedAt`), so a computer whose clock differs cannot hide a visit.
 * - `since`, per presenter owner (a workspace's presenters share one): the newest visit any of them had when this
 *   browser first listed them, so what was there before counts as seen and presenters made later are compared to it.
 * - `seen`, per presenter: the newest visit it had when its transcripts were last opened here.
 * Nothing is dropped when a list leaves a presenter out, as the list holds only the workspace in use.
 */
export interface SeenVisits {
  since: Record<string, string>;
  seen: Record<string, string>;
}

type Listed = Pick<Agent, "id" | "ownerId" | "lastVisitAt">;

const strings = (value: unknown): Record<string, string> =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string")) : {};

/** The record as stored, or an empty one for anything that is not one. */
export function parseSeenVisits(raw: string | null): SeenVisits {
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (!parsed || typeof parsed !== "object") return { since: {}, seen: {} };
    const { since, seen } = parsed as Record<string, unknown>;
    return { since: strings(since), seen: strings(seen) };
  } catch {
    return { since: {}, seen: {} };
  }
}

/** Starts the count for each owner listed for the first time; `null` when every owner listed already has one. */
export function seedSeenVisits(record: SeenVisits, agents: Listed[]): SeenVisits | null {
  const since = { ...record.since };
  let changed = false;
  for (const a of agents) {
    if (a.ownerId in record.since) continue;
    const at = a.lastVisitAt ?? "";
    if (!(a.ownerId in since) || at > since[a.ownerId]) since[a.ownerId] = at;
    changed = true;
  }
  return changed ? { ...record, since } : null;
}

/** Whether a visit started after the presenter's transcripts were last opened here (or, never opened, after its owner was first listed). */
export function hasNewVisits(record: SeenVisits, agent: Listed): boolean {
  const seen = record.seen[agent.id] ?? record.since[agent.ownerId];
  return !!agent.lastVisitAt && seen !== undefined && agent.lastVisitAt > seen;
}

/**
 * Two records as one, for a write that another tab may have written to since this one read: an owner's first start
 * stands, and a presenter keeps the later of its two seen times.
 */
export function mergeSeenVisits(stored: SeenVisits, mine: SeenVisits): SeenVisits {
  const seen = { ...stored.seen };
  for (const [id, at] of Object.entries(mine.seen)) if (!(id in seen) || at > seen[id]) seen[id] = at;
  return { since: { ...mine.since, ...stored.since }, seen };
}

/** Records that a presenter's visits up to `at` have been shown; an older time never replaces a newer one. */
export function markVisitsSeen(record: SeenVisits, agentId: string, at: string): SeenVisits {
  const was = record.seen[agentId];
  return was !== undefined && was >= at ? record : { ...record, seen: { ...record.seen, [agentId]: at } };
}
