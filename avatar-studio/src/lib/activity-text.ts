// Sentences for the activity feed. Shared by the Workspace page and its tests; no server imports.
import { describeReplaced } from "./presenters";
import { roleArticle } from "./roles";
import type { ActivityEvent, ActivityKind } from "./types";

/** The parts of the feed a reader can show on their own, in the order the filter lists them. */
export const ACTIVITY_AREAS = ["videos", "reviews", "members", "keys", "brand", "presenters", "replaces"] as const;
export type ActivityArea = (typeof ACTIVITY_AREAS)[number];

/** How the filter names each area. */
export const ACTIVITY_AREA_LABELS: Record<ActivityArea, string> = {
  videos: "Videos and batches",
  reviews: "Reviews",
  members: "Members and invites",
  keys: "API keys",
  brand: "Brand kit",
  presenters: "Shared presenters",
  replaces: "Presenter and voice replaces",
};

// A Record over every kind, so a new kind does not compile until it is given an area.
const AREA_OF_KIND: Record<ActivityKind, ActivityArea> = {
  "video.created": "videos",
  "video.trashed": "videos",
  "video.restored": "videos",
  "video.purged": "videos",
  "batch.created": "videos",
  "video.review_requested": "reviews",
  "video.approved": "reviews",
  "video.changes_requested": "reviews",
  "member.joined": "members",
  "member.left": "members",
  "member.removed": "members",
  "member.role": "members",
  "invite.sent": "members",
  "invite.resent": "members",
  "invite.role": "members",
  "invite.revoked": "members",
  "apikey.created": "keys",
  "apikey.revoked": "keys",
  "apikey.renamed": "keys",
  "brand.saved": "brand",
  "brand.removed": "brand",
  "agent.created": "presenters",
  "agent.duplicated": "presenters",
  "agent.deleted": "presenters",
  "usage.replaced": "replaces",
};

/** The area an event's kind belongs to. */
export function activityArea(kind: ActivityKind): ActivityArea {
  return AREA_OF_KIND[kind];
}

/** The area a select value names, or none for Everything or a value that is not an area. */
export function parseActivityArea(value: string | null | undefined): ActivityArea | null {
  return (ACTIVITY_AREAS as readonly string[]).includes(value ?? "") ? (value as ActivityArea) : null;
}

/**
 * The words naming a filtered view of the feed, e.g. ` under “Reviews” by ann@example.com`: the area as the Show
 * select names it (quoted when `quote` is set) and the person as the Who select describes them. Empty for neither.
 */
export function activityFilterPhrase(area: ActivityArea | null, who: string | null, quote = false): string {
  const label = area ? ACTIVITY_AREA_LABELS[area] : null;
  return `${label ? ` under ${quote ? `“${label}”` : label}` : ""}${who ? ` by ${who}` : ""}`;
}

/** Who did it, from the viewer's point of view. */
export function activityActor(e: Pick<ActivityEvent, "actorId" | "actorEmail" | "ownerId">, viewerId?: string): string {
  if (viewerId && e.actorId === viewerId) return "You";
  if (e.actorEmail) return e.actorEmail;
  if (e.actorId === e.ownerId) return "A script with an API key";
  return "A member";
}

/** The event as a sentence, e.g. `You moved "Welcome" to the trash`. */
export function describeActivity(e: ActivityEvent, viewerId?: string): string {
  const who = activityActor(e, viewerId);
  const what = e.subject ? `"${e.subject}"` : "";
  const n = e.count ?? 0;
  const videos = `${n} ${n === 1 ? "video" : "videos"}`;
  switch (e.kind) {
    case "video.created":
      return `${who} created ${what || "a video"}`;
    case "video.trashed":
      return e.count !== undefined ? `${who} moved ${videos} to the trash` : `${who} moved ${what || "a video"} to the trash`;
    case "video.restored":
      return e.count !== undefined ? `${who} restored ${videos} from the trash` : `${who} restored ${what || "a video"} from the trash`;
    case "video.purged":
      return e.count !== undefined ? `${who} deleted ${videos} for good` : `${who} deleted ${what || "a video"} for good`;
    case "batch.created":
      return `${who} started a batch of ${videos}${what ? ` from ${what}` : ""}`;
    case "member.joined":
      return `${who} joined the workspace`;
    case "member.left":
      return `${who} left the workspace`;
    case "member.removed":
      return `${who} removed ${what || "a member"}`;
    case "member.role":
      return `${who} made ${what || "a member"} ${roleArticle(e.role)}`;
    // An invite names its address (`subject`); with none it is a link invite, unless `count` says how many
    // addressed invites it was (a batch, or one whose address is hidden from a reader who is not an owner).
    case "invite.sent":
      if (what) return `${who} invited ${what} as ${roleArticle(e.role)}`;
      if (e.count !== undefined) return `${who} invited ${n} ${n === 1 ? "person" : "people"} as ${n === 1 ? roleArticle(e.role) : rolePlural(e.role)}`;
      return `${who} made ${roleArticle(e.role)} invite link`;
    // A resend always renews the link; it is emailed only when email is set up, so the line does not claim it was.
    case "invite.resent":
      if (what) return `${who} renewed the invite to ${what}`;
      return e.count !== undefined ? `${who} renewed an invite` : `${who} renewed ${roleArticle(e.role)} invite link`;
    case "invite.role":
      return `${who} changed ${what ? `the invite to ${what}` : e.count !== undefined ? "an invite" : "an invite link"} to join as ${roleArticle(e.role)}`;
    case "invite.revoked":
      if (what) return `${who} revoked the invite to ${what}`;
      return e.count !== undefined ? `${who} revoked an invite` : `${who} revoked ${roleArticle(e.role)} invite link`;
    case "apikey.created":
      return `${who} created the API key ${what}`.trimEnd();
    case "apikey.revoked":
      return `${who} revoked the API key ${what}`.trimEnd();
    case "apikey.renamed":
      return e.previous ? `${who} renamed the API key "${e.previous}" to ${what}`.trimEnd() : `${who} renamed an API key to ${what}`.trimEnd();
    case "brand.saved":
      return `${who} saved the brand kit${what ? ` ${what}` : ""}`;
    case "brand.removed":
      return `${who} removed the brand kit`;
    case "agent.created":
      return `${who} shared the presenter ${what}`.trimEnd();
    case "agent.duplicated":
      return `${who} copied a shared presenter as ${what}`.trimEnd();
    case "agent.deleted":
      return `${who} deleted the shared presenter ${what}`.trimEnd();
    case "video.review_requested":
      return `${who} asked for a review of ${what || "a video"}`;
    case "video.approved":
      return `${who} approved ${what || "a video"}`;
    case "video.changes_requested":
      return `${who} asked for changes to ${what || "a video"}`;
    case "usage.replaced": {
      // Worded here from the counts, so the sentence is never cut short; a name the server could not find is left out.
      const thing = e.replaced?.kind === "voice" ? "voice" : e.replaced?.kind === "avatar" ? "presenter" : "presenter or voice";
      const changed = e.replaced ? describeReplaced(e.replaced) : "";
      return `${who} replaced ${what || `a deleted ${thing}`} with ${e.replacement ? `"${e.replacement}"` : `another ${thing}`}${changed ? ` in ${changed}` : ""}`;
    }
  }
}

/** A role in the plural, for a batch: "editors", "viewers", "owners". */
function rolePlural(role: string | undefined): string {
  return role === "owner" ? "owners" : role === "viewer" ? "viewers" : "editors";
}

const INVITE_KINDS = new Set<ActivityKind>(["invite.sent", "invite.resent", "invite.role", "invite.revoked"]);

/**
 * The feed as a reader who is not a workspace owner sees it: pending invitees' addresses are for owners
 * only (as on the Workspace page), so an addressed invite reads as "an invite" or "1 person" instead.
 */
export function hideInviteAddresses(events: ActivityEvent[]): ActivityEvent[] {
  return events.map((e) => {
    if (!INVITE_KINDS.has(e.kind) || !e.subject) return e;
    const { subject: _hidden, ...rest } = e;
    return { ...rest, count: e.count ?? 1 };
  });
}

/** The columns of the feed's CSV download. */
export const ACTIVITY_CSV_COLUMNS = ["when", "who", "area", "kind", "what_happened"];

/**
 * The feed as spreadsheet rows, newest first as given: the time as stored (ISO, sortable), who did it, the
 * area the Show filter names it under, the stored kind, and the sentence the feed shows, worded for no one
 * in particular so the file reads the same for whoever downloads it.
 */
export function activityRows(events: ActivityEvent[]): Array<Record<string, string>> {
  return events.map((e) => ({
    when: e.createdAt,
    who: activityActor(e),
    area: ACTIVITY_AREA_LABELS[activityArea(e.kind)],
    kind: e.kind,
    what_happened: describeActivity(e),
  }));
}

/** Where this browser keeps, per reader and space, the time of the newest teammate event shown when the feed was last opened. */
export const ACTIVITY_SEEN_PREFIX = "avatar-studio:activity-seen:";

/** The key for one reader's mark in one workspace, so people sharing a browser each keep their own. */
export function activitySeenKey(userId: string, ownerId: string): string {
  return `${ACTIVITY_SEEN_PREFIX}${userId}:${ownerId}`;
}

/**
 * The events someone other than `viewerId` did after `seenAt`, the mark kept when the feed was last opened here. With
 * no mark (a first visit, or storage that cannot be read) nothing is new; the reader's own events are never new, and
 * one in the very millisecond of the mark is not new either. Events made with an API key carry the space's own id,
 * not a person's, so they count as a teammate's, including those from the reader's own scripts.
 */
export function newActivityIds(events: Array<Pick<ActivityEvent, "id" | "actorId" | "createdAt">>, seenAt: string | null, viewerId: string | undefined): Set<string> {
  const since = seenAt === null ? Number.NaN : Date.parse(seenAt);
  if (Number.isNaN(since)) return new Set();
  return new Set(events.filter((e) => e.actorId !== viewerId && Date.parse(e.createdAt) > since).map((e) => e.id));
}

/**
 * The mark to keep once the whole feed is shown: the newest event a teammate did, by the server's clock, or the mark
 * already kept when that is later (the feed opened in another tab), so the mark never moves back. With neither, the
 * start of time, so every later teammate event is new.
 */
export function activitySeenMark(events: Array<Pick<ActivityEvent, "actorId" | "createdAt">>, viewerId: string | undefined, before: string | null): string {
  let newest = before === null ? Number.NEGATIVE_INFINITY : Date.parse(before);
  if (Number.isNaN(newest)) newest = Number.NEGATIVE_INFINITY;
  for (const e of events) if (e.actorId !== viewerId) newest = Math.max(newest, Date.parse(e.createdAt) || Number.NEGATIVE_INFINITY);
  return new Date(Number.isFinite(newest) ? newest : 0).toISOString();
}

/**
 * How many events are new, as the feed and Home say it: the count, or "30+" when every one of the `limit` loaded is
 * new, as more may wait beyond them. Empty when none is.
 */
export function newActivityCount(fresh: number, loaded: number, limit: number): string {
  if (fresh <= 0) return "";
  return fresh === loaded && loaded >= limit ? `${fresh}+` : String(fresh);
}

/** Home's line for teammate activity new since the feed was last shown here, e.g. "3 new in the workspace's activity since you last opened it". */
export function newActivityLine(count: string): string {
  return `${count} new in the workspace's activity since you last opened it`;
}

/** How many events the feed shows at first and adds with each Show more. */
export const ACTIVITY_PAGE = 30;
/** How many events an owner keeps; the feed can show them all. */
export const ACTIVITY_KEPT = 200;

/** The feed's next length after Show more: another page, up to every event kept. */
export function nextActivityLimit(limit: number): number {
  return Math.min(limit + ACTIVITY_PAGE, ACTIVITY_KEPT);
}

/** Whether Show more can bring more: the last answer filled the length asked for, and that is short of all kept. */
export function canShowMoreActivity(shown: number, limit: number): boolean {
  return shown >= limit && limit < ACTIVITY_KEPT;
}
