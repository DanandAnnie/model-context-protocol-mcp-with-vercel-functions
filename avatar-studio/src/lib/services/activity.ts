// Activity feed: what the people in an account or workspace did, newest first. Written by the API
// routes (which know who made the request) and read by the Workspace page and the account export.
import { z } from "zod";
import { ACTIVITY_AREAS, ACTIVITY_KEPT, activityArea, type ActivityArea } from "../activity-text";
import { newId } from "../ids";
import { LOCAL_OWNER } from "../owner-id";
import { getStore, type ItemKind } from "../store";
import type { Video } from "../types";
import { purgeDue } from "./videos";
import type { ActivityEvent, ActivityKind } from "../types";
import type { User } from "../workspaces";

/** How many events an owner keeps; older ones go when a new one is recorded. */
export const MAX_ACTIVITY = ACTIVITY_KEPT;
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
  /** `0` leaves out `links` (an empty map), for a caller that only counts events, such as Home. */
  links: z.enum(["0", "1"]).optional(),
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

/** How many lines' links are checked at the same time. */
const LINK_CHECKS_AT_ONCE = 10;

/** The kinds whose subject is a video, and so link to its page while it is still kept (the trash included). */
const VIDEO_KINDS = new Set<ActivityKind>(["video.created", "video.trashed", "video.restored", "video.review_requested", "video.approved", "video.changes_requested"]);

/**
 * Where each event's line leads, keyed by event id: a video's page, the shared presenters, the API keys, the
 * brand kit, or the Avatars or Voices page for a replace. Only for what still exists in this owner's space, so a
 * line never leads to a page that says "not found"; a bulk action, a member, or a thing since deleted has none.
 */
export async function activityLinks(ownerId: string, events: ActivityEvent[]): Promise<Record<string, string>> {
  const store = getStore();
  const now = Date.now();
  const checked = new Map<string, Promise<boolean>>();
  const exists = (kind: ItemKind, id: string): Promise<boolean> => {
    const key = `${kind}:${id}`;
    if (!checked.has(key)) {
      checked.set(
        key,
        store
          .get<{ ownerId?: string }>(kind, id)
          .then((item) => {
            if (!item) return false;
            // A brand kit is the owner's only when it says so, as the Brand page reads it; other records follow
            // the store's rule that one with no owner belongs to the local owner.
            if ((kind === "brand" ? item.ownerId : (item.ownerId ?? LOCAL_OWNER)) !== ownerId) return false;
            // A video past its time in the trash answers "not found" until a listing deletes it.
            return kind !== "video" || !purgeDue(item as Video, now);
          })
          .catch((err) => {
            console.error(`activity link check for ${kind} ${id} failed:`, err);
            return false;
          }),
      );
    }
    return checked.get(key)!;
  };
  const linkFor = async (e: ActivityEvent): Promise<string | null> => {
    if (VIDEO_KINDS.has(e.kind)) return e.subjectId && (await exists("video", e.subjectId)) ? `/videos/${encodeURIComponent(e.subjectId)}` : null;
    if (e.kind === "agent.created" || e.kind === "agent.duplicated") return e.subjectId && (await exists("agent", e.subjectId)) ? "/interactive" : null;
    if (e.kind === "apikey.created") return e.subjectId && (await exists("apikey", e.subjectId)) ? "/settings" : null;
    if (e.kind === "brand.saved") return (await exists("brand", `brand_${ownerId}`)) ? "/brand" : null;
    if (e.kind === "usage.replaced") return e.replaced?.kind === "voice" ? "/voices" : e.replaced?.kind === "avatar" ? "/avatars" : null;
    return null;
  };
  const links: Record<string, string> = {};
  // A few lines at a time, so a long page does not send the store a burst of reads at once.
  for (let i = 0; i < events.length; i += LINK_CHECKS_AT_ONCE) {
    await Promise.all(
      events.slice(i, i + LINK_CHECKS_AT_ONCE).map(async (e) => {
        const href = await linkFor(e);
        if (href) links[e.id] = href;
      }),
    );
  }
  return links;
}
