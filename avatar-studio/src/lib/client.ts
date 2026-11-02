import { pauseSeconds, stripPauses } from "./pauses";
// Browser-side helpers for calling the app's own API.
import { TRASH_RETENTION_DAYS } from "./types";
export class ApiError extends Error {
  /** `body` is the parsed error response, for routes that return a record alongside the error (e.g. a failed render). */
  constructor(message: string, public status: number, public issues?: unknown, public body?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * The message a failed response should show. Schema failures arrive as a generic
 * "Invalid request" plus the field issues, so the first issue's own wording
 * ("The link must start with http:// or https://") is used when there is one.
 */
export function errorMessage(body: Record<string, unknown>, status: number): string {
  const error = typeof body.error === "string" ? body.error : `Request failed (${status})`;
  const issues = Array.isArray(body.issues) ? (body.issues as Array<{ message?: unknown }>) : [];
  const first = issues.find((i) => typeof i?.message === "string" && i.message.trim())?.message;
  return typeof first === "string" ? first : error;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch (err) {
    // A page closing or a request it cancelled is not a failure to report.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    // No answer at all (offline, the connection dropped): said plainly, not as the browser's "Failed to fetch".
    throw new ApiError("The server could not be reached; check your connection and try again", 0, undefined, {});
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // An HTML error page (a proxy, a timeout) is not an answer to show as it is.
    throw new ApiError(res.ok ? "The server sent an answer the page could not read; try again" : `The server could not answer (${res.status}); try again`, res.status, undefined, {});
  }
  if (!res.ok) {
    throw new ApiError(errorMessage(body, res.status), res.status, body.issues, body);
  }
  return body as T;
}

/**
 * An error answer that refuses a start, so trying again is a new start with a new idempotency key; not a lost answer
 * (5xx, a timeout) nor a `409` for a start the renderer is still working on, whose retry must keep the key.
 */
export function isRefusal(e: unknown): boolean {
  // Status 0 is no answer at all (see `api`): the start may have gone through, so its key is kept.
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && !(e.status === 409 && /still being sent/.test(e.message));
}

/** The poster to show for a video: its custom cover (versioned so a replacement is never cached) or the provider thumbnail. */
export function posterUrl(video: { id: string; cover?: { updatedAt: string }; thumbnailUrl?: string }, base = ""): string | undefined {
  if (video.cover) return `${base}/api/videos/${video.id}/cover?v=${Date.parse(video.cover.updatedAt)}`;
  return video.thumbnailUrl;
}

/** Text made safe inside an HTML attribute or element. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * What an email carries for a shared video: its animated preview (a fixed address that redirects to the renderer's GIF,
 * or to the cover) linked to the share page, as HTML for a mail client, and the bare link for one that pastes text.
 */
export function emailSnippet(video: { id: string; title: string; aspect?: string; cover?: unknown }, base: string): { html: string; text: string } {
  const share = `${base.replace(/\/$/, "")}/share/${video.id}`;
  // Sized in the video's shape, so a mail client that ignores the style (Outlook) keeps it; a cover, which the picture
  // may be (a link asking for an email first) and can be of any shape, is sized by its width alone.
  const [width, height] = video.aspect === "9:16" ? [270, 480] : video.aspect === "1:1" ? [360, 360] : [480, 270];
  const sized = video.cover ? "" : ` height="${height}"`;
  const alt = escapeHtml(`Watch the video: ${video.title}`);
  const html = `<a href="${escapeHtml(share)}"><img src="${escapeHtml(`${share}/preview.gif`)}" alt="${alt}" width="${width}"${sized} style="display:block;max-width:100%;height:auto;border:0"></a>`;
  return { html, text: share };
}

/** True once a share link's expiry has passed. */
export function shareExpired(video: { shareExpiresAt?: string }, now = Date.now()): boolean {
  return !!video.shareExpiresAt && Date.parse(video.shareExpiresAt) <= now;
}

/** True while a link scheduled to go live later has not gone live yet. */
export function shareNotYet(video: { shareStartsAt?: string }, now = Date.now()): boolean {
  return !!video.shareStartsAt && Date.parse(video.shareStartsAt) > now;
}

/**
 * True while the public should see "not found": the owner switched the link off, it expired, it is scheduled to go
 * live later, or the video is in the trash.
 */
export function shareOffline(video: { shareDisabled?: boolean; shareExpiresAt?: string; shareStartsAt?: string; deletedAt?: string }, now = Date.now()): boolean {
  return !!video.shareDisabled || !!video.deletedAt || shareExpired(video, now) || shareNotYet(video, now);
}

/**
 * A video's share link when a viewer can open it now (rendered, out of the trash, switched on, live, not expired) on
 * `origin`, else undefined; a password or an email gate does not stop it being sent.
 */
export function sendableShareLink(video: { id: string; status: string; shareDisabled?: boolean; shareExpiresAt?: string; shareStartsAt?: string; deletedAt?: string }, origin: string, now = Date.now()): string | undefined {
  return video.status === "completed" && !shareOffline(video, now) ? `${origin.replace(/\/$/, "")}/share/${video.id}` : undefined;
}

/**
 * Which one of the share states a video's link is in, as its card's badges say: switched off wins over expired, which
 * wins over not live yet; anything else is live (a password or a coming expiry does not take it offline).
 */
export function shareState(video: { shareDisabled?: boolean; shareExpiresAt?: string; shareStartsAt?: string }, now = Date.now()): "off" | "expired" | "scheduled" | "live" {
  if (video.shareDisabled) return "off";
  if (shareExpired(video, now)) return "expired";
  if (shareNotYet(video, now)) return "scheduled";
  return "live";
}

/** Days within which a live link's coming expiry is pointed out on its library card. */
export const EXPIRES_SOON_DAYS = 7;

/**
 * "Expires in N days" (rounded up) when a live link expires within `EXPIRES_SOON_DAYS`, or in hours when less than a
 * day is left, so a link about to lapse does not read as having a day to spare; undefined for a link with no expiry,
 * one further off, or one the public cannot reach anyway (off, expired, not live yet, or in the trash).
 */
export function shareExpiresSoon(video: { shareDisabled?: boolean; shareExpiresAt?: string; shareStartsAt?: string; deletedAt?: string }, now = Date.now()): string | undefined {
  if (!video.shareExpiresAt || shareOffline(video, now)) return undefined;
  const left = Date.parse(video.shareExpiresAt) - now;
  if (left < 86_400_000) {
    const hours = Math.ceil(left / 3_600_000);
    return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.ceil(left / 86_400_000);
  return days <= EXPIRES_SOON_DAYS ? `Expires in ${days} ${days === 1 ? "day" : "days"}` : undefined;
}

/** When a trashed video is deleted for good, as an ISO instant; undefined for a video that is not in the trash. */
export function purgeAt(video: { deletedAt?: string }): string | undefined {
  return video.deletedAt ? new Date(Date.parse(video.deletedAt) + TRASH_RETENTION_DAYS * 86_400_000).toISOString() : undefined;
}

/** Whole days until a trashed video is deleted for good (never below zero). */
export function daysUntilPurge(video: { deletedAt?: string }, now = Date.now()): number {
  const at = purgeAt(video);
  return at ? Math.max(0, Math.ceil((Date.parse(at) - now) / 86_400_000)) : 0;
}

/**
 * The folder a typed name means: the existing folder of exactly that name (trimmed, as the server stores it), else one
 * whose name matches apart from letter case and spacing (so "launch " joins "Launch" rather than starting a near twin),
 * else the name as typed, trimmed. Empty is Unfiled.
 */
export function folderFor(typed: string, folders: readonly string[]): string {
  const name = typed.trim();
  if (!name || folders.includes(name)) return name;
  // Locale-independent, so a Turkish browser lowercases "INFO" as everyone else does.
  const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return folders.find((f) => key(f) === key(name)) ?? name;
}

/**
 * A click on a library video while selecting. A plain click turns that one video on or off; Shift+click sets every
 * video from the last one clicked to this one, in the order shown, as the last one clicked now is (so a run of cards
 * is picked, or dropped, in two clicks). Either way this video is the one clicked last. With no video clicked last, or
 * one no longer among `order` (deleted, or moved out of the folder shown, by someone else), Shift+click is a plain click.
 */
export function clickSelect(
  selected: ReadonlySet<string>,
  order: readonly string[],
  anchor: string | null,
  id: string,
  shift: boolean,
): { selected: Set<string>; anchor: string } {
  const next = new Set(selected);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  if (!shift || anchor === null || from < 0 || to < 0 || from === to) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id };
  }
  const on = next.has(anchor);
  for (const v of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
    if (on) next.add(v);
    else next.delete(v);
  }
  return { selected: next, anchor: id };
}

/**
 * Why a library bulk action cannot take this selection, or null when it can: one action takes up to `max` videos
 * (the server's own limit), and a bigger selection is refused here with how many to unselect rather than as a 400.
 */
export function overSelection(count: number, max: number): string | null {
  if (count <= max) return null;
  const extra = count - max;
  return `One action takes up to ${max} videos and ${count} are selected; unselect ${extra} first, or act on them in two goes.`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Words a script speaks: pause markers are not words. */
export function wordCount(text: string): number {
  return stripPauses(text).trim().split(/\s+/).filter(Boolean).length;
}

/** Rough spoken duration estimate: ~2.5 words per second at 1.0x, plus the script's pauses. */
export function estimateSeconds(text: string, speed = 1): number {
  return Math.round(wordCount(text) / 2.5 / speed + pauseSeconds(text));
}

/** True when a hex color is dark enough to need light text on top of it. */
export function isDarkHex(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

export function formatSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

/**
 * A line on what a video's share link does now, as its card's badges say: why it cannot be opened ("Link off",
 * "Expired", "Scheduled"), or when it stops ("Expires in 3 days"), and whether it asks for a password. Nothing for a link
 * open as it is, or for a video in the trash (its link answers "not found" whatever it was set to).
 */
export function shareSummary(video: { shareDisabled?: boolean; shareExpiresAt?: string; shareStartsAt?: string; shareLocked?: boolean; deletedAt?: string }, now = Date.now()): string | undefined {
  if (video.deletedAt) return undefined;
  const state = video.shareDisabled ? "Link off" : shareExpired(video, now) ? "Expired" : shareNotYet(video, now) ? "Scheduled" : shareExpiresSoon(video, now);
  const notes = [state, video.shareLocked ? "Password" : undefined].filter(Boolean);
  return notes.length ? notes.join(" · ") : undefined;
}
