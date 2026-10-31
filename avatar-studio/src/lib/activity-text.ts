// Sentences for the activity feed. Shared by the Workspace page and its tests; no server imports.
import { roleArticle } from "./roles";
import type { ActivityEvent } from "./types";

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
  }
}
