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
  members: "Members",
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
  "apikey.created": "keys",
  "apikey.revoked": "keys",
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
    case "apikey.created":
      return `${who} created the API key ${what}`.trimEnd();
    case "apikey.revoked":
      return `${who} revoked the API key ${what}`.trimEnd();
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
