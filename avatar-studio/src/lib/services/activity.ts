// Activity feed: what the people in an account or workspace did, newest first. Written by the API
// routes (which know who made the request) and read by the Workspace page and the account export.
import { z } from "zod";
import { ACTIVITY_AREAS, activityArea, type ActivityArea } from "../activity-text";
import { newId } from "../ids";
import { getStore } from "../store";
import type { ActivityEvent, ActivityKind } from "../types";
import type { User } from "../workspaces";

/** How many events an owner keeps; older ones go when a new one is recorded. */
export const MAX_ACTIVITY = 200;
/** How long a subject label may be in the feed. */
const MAX_SUBJECT = 80;

export const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_ACTIVITY).default(50),
  /** Only this part of the feed: videos, reviews, members, keys, brand, presenters, or replaces. */
  area: z.enum(ACTIVITY_AREAS).optional(),
  /** Only the events this person did: a member's user id, or the owner id itself for scripts with an API key. */
  actor: z.string().trim().min(1).max(200).optional(),
  /** `csv` downloads every kept event of the area (the limit is not applied) as a spreadsheet. */
  format: z.enum(["csv"]).optional(),
});

declare global {
  // eslint-disable-next-line no-var
  var __avatarStudioActivityStamp: number | undefined;
}

/**
 * Event times are strictly increasing within an instance, so events recorded in one millisecond
 * (a bulk action and the request behind it, a burst of tests) still list in the order they happened.
 * The last stamp is held on globalThis, like the store: module scope is not shared across route bundles.
 */
function stamp(): string {
  const ms = Math.max(Date.now(), (globalThis.__avatarStudioActivityStamp ?? 0) + 1);
  globalThis.__avatarStudioActivityStamp = ms;
  return new Date(ms).toISOString();
}

export interface ActivityDetails {
  subject?: string;
  subjectId?: string;
  count?: number;
  role?: string;
  replacement?: string;
  replaced?: ActivityEvent["replaced"];
}

/**
 * Records an event. Best effort: the feed is a convenience, so a store failure here is logged and
 * never fails the request that did the work. The owner's oldest events beyond the cap are removed.
 */
export async function recordActivity(ownerId: string, actor: User, kind: ActivityKind, details: ActivityDetails = {}): Promise<ActivityEvent | null> {
  try {
    const event: ActivityEvent = {
      id: newId("act"),
      ownerId,
      kind,
      actorId: actor.id,
      ...(actor.email ? { actorEmail: actor.email } : {}),
      ...(details.subject ? { subject: Array.from(details.subject.trim()).slice(0, MAX_SUBJECT).join("") } : {}),
      ...(details.subjectId ? { subjectId: details.subjectId } : {}),
      ...(details.count !== undefined ? { count: details.count } : {}),
      ...(details.role ? { role: details.role } : {}),
      ...(details.replacement ? { replacement: Array.from(details.replacement.trim()).slice(0, MAX_SUBJECT).join("") } : {}),
      ...(details.replaced ? { replaced: { kind: details.replaced.kind, agents: details.replaced.agents, templates: details.replaced.templates, brand: details.replaced.brand, avatars: details.replaced.avatars } } : {}),
      createdAt: stamp(),
    };
    await getStore().put("activity", event);
    const all = sorted(await getStore().list<ActivityEvent>("activity", ownerId));
    for (const old of all.slice(MAX_ACTIVITY)) await getStore().remove("activity", old.id);
    return event;
  } catch (err) {
    console.error(`activity ${kind} for ${ownerId} not recorded:`, err);
    return null;
  }
}

/** The owner's events, newest first; with an area or a person, only the events matching both, up to `limit` of them. */
export async function listActivity(ownerId: string, limit: number = 50, area?: ActivityArea, actorId?: string): Promise<ActivityEvent[]> {
  const all = sorted(await getStore().list<ActivityEvent>("activity", ownerId));
  return all.filter((e) => (!area || activityArea(e.kind) === area) && (!actorId || e.actorId === actorId)).slice(0, limit);
}

function sorted(events: ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
