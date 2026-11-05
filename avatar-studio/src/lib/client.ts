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

/**
 * The clip a library card plays, muted, while it is hovered: the finished render's own file, for a video out of the
 * trash. A render still under way or failed has none, and only a web address or a path on this site is played (a path
 * a browser would read as another host, as `/\\host` or `//host`, is neither).
 */
export function cardPreviewSrc(video: { status: string; videoUrl?: string; deletedAt?: string }): string | undefined {
  if (video.status !== "completed" || video.deletedAt || !video.videoUrl) return undefined;
  return /^https?:\/\//i.test(video.videoUrl) || /^\/(?![\/\\])[\x21-\x7e]*$/.test(video.videoUrl) ? video.videoUrl : undefined;
}

/** How long a card is hovered (or focused) before its clip starts, so moving the pointer across the grid loads nothing. */
export const CARD_PREVIEW_DELAY_MS = 300;

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

/** Why a batch gave no links to copy or QR codes to save: its links CSV has no reason column, so the reasons are said here. */
export const BATCH_NOTHING_TO_SEND = "None of this batch's videos has a link that can be sent yet: each is still rendering, failed, or has its share link switched off, expired, or not live until later.";

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

/** The longest a page waits before looking at its share links' times again. */
export const SHARE_RECHECK_MAX_MS = 3_600_000;

/**
 * How long until the soonest of these videos' share links goes live or expires (from `now`, in ms, at most
 * `SHARE_RECHECK_MAX_MS`), so a page can show the change when it happens; undefined when none of them is due to change.
 * A coming expiry also counts each whole hour before it, when an "Expires in N hours" (or days) badge changes. A link
 * switched off or a video in the trash changes only when someone changes it.
 */
export function nextShareChange(videos: Array<{ shareDisabled?: boolean; shareExpiresAt?: string; shareStartsAt?: string; deletedAt?: string }>, now = Date.now()): number | undefined {
  let soonest: number | undefined;
  for (const v of videos) {
    if (v.shareDisabled || v.deletedAt) continue;
    for (const iso of [v.shareStartsAt, v.shareExpiresAt]) {
      const at = iso ? Date.parse(iso) : NaN;
      if (!(at > now)) continue;
      // An expiry's next whole hour before it, when its badge's count goes down (the badges round up).
      const next = iso === v.shareExpiresAt ? now + ((at - now) % SHARE_RECHECK_MAX_MS || SHARE_RECHECK_MAX_MS) : at;
      if (soonest === undefined || next < soonest) soonest = next;
    }
  }
  return soonest === undefined ? undefined : Math.min(soonest - now, SHARE_RECHECK_MAX_MS);
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

/** The share states the library filters by: one of `shareState`'s, or "expiring" for a link `shareExpiresSoon` badges. */
export const SHARE_FILTERS = ["live", "expiring", "scheduled", "off", "expired"] as const;

export type ShareFilter = (typeof SHARE_FILTERS)[number];

/**
 * Whether a video's share link is in `share`, as the library's share filter reads it. A video in the trash is in none:
 * its link answers "not found" whatever it was set to.
 */
export function inShareFilter(video: { shareDisabled?: boolean; shareExpiresAt?: string; shareStartsAt?: string; deletedAt?: string }, share: ShareFilter, now = Date.now()): boolean {
  if (video.deletedAt) return false;
  return share === "expiring" ? !!shareExpiresSoon(video, now) : shareState(video, now) === share;
}

/**
 * How many of these videos' share links need a look: those expiring within `EXPIRES_SOON_DAYS`, and those that have
 * expired while still switched on, so whoever has the link is told it expired. The library's "expiring" and "expired"
 * share filters list the same videos, by the server's clock where this counts by `now` (the browser's, on Home).
 */
export function shareAttention(videos: { shareDisabled?: boolean; shareExpiresAt?: string; shareStartsAt?: string; deletedAt?: string }[], now = Date.now()): { expiring: number; expired: number } {
  let expiring = 0;
  let expired = 0;
  for (const v of videos) {
    if (inShareFilter(v, "expiring", now)) expiring++;
    else if (inShareFilter(v, "expired", now)) expired++;
  }
  return { expiring, expired };
}

/** The library's "made within" windows, in days: rolling windows of 24-hour days counted back from `now`. */
export const CREATED_WITHIN_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;

/** The library's shape filter, by the aspect ratio a video was made in: landscape 16:9, portrait 9:16, square 1:1. */
export const SHAPE_ASPECT = { landscape: "16:9", portrait: "9:16", square: "1:1" } as const;
export const SHAPE_FILTERS = Object.keys(SHAPE_ASPECT) as (keyof typeof SHAPE_ASPECT)[];

/** Whether a video was made in a shape; one stored without an aspect ratio was made in the 16:9 default. */
export function inShape(video: { aspect?: string }, shape: keyof typeof SHAPE_ASPECT): boolean {
  return (video.aspect ?? "16:9") === SHAPE_ASPECT[shape];
}

/** The library's length filter, by a finished video's running time: under a minute, one to three minutes, over three. */
export const LENGTH_FILTERS = ["short", "medium", "long"] as const;
export type LengthFilter = (typeof LENGTH_FILTERS)[number];

/**
 * Whether a finished video's running time is in a length: `short` under 60 seconds, `medium` 60 to 180 seconds, `long`
 * over 180. Only a completed render has a running time, so a video still rendering, or one that failed, is in no length.
 */
export function inLength(video: { status?: string; durationSec?: number }, length: LengthFilter): boolean {
  if (video.status !== "completed" || typeof video.durationSec !== "number" || !Number.isFinite(video.durationSec) || video.durationSec <= 0) return false;
  // Judged by the time a card shows, so a video reading "3m 00s" is never under Over 3 minutes.
  const d = shownSeconds(video.durationSec);
  return length === "short" ? d < 60 : length === "medium" ? d >= 60 && d <= 180 : d > 180;
}

/** The library's views filter: the finished videos whose share page has been viewed, or those not viewed yet. */
export const VIEWED_FILTERS = ["yes", "no"] as const;
export type ViewedFilter = (typeof VIEWED_FILTERS)[number];

/**
 * Whether a video is in a views filter: `yes` for one whose share page has been viewed at least once, `no` for a finished
 * one with no view yet (a recipient still to follow up). Only a completed render can be viewed, so a video still
 * rendering, or one that failed, is in neither.
 */
export function inViewed(video: { status?: string; views?: number }, viewed: ViewedFilter): boolean {
  if (video.status !== "completed") return false;
  return viewed === "yes" ? (video.views ?? 0) > 0 : !((video.views ?? 0) > 0);
}

export type CreatedWithin = keyof typeof CREATED_WITHIN_DAYS;

/** Whether a video was made within `created` of `now`; an unreadable creation time (NaN) is in no window. */
export function madeWithin(video: { createdAt: string }, created: CreatedWithin, now = Date.now()): boolean {
  return Date.parse(video.createdAt) >= now - CREATED_WITHIN_DAYS[created] * 86_400_000;
}

/**
 * Renders among these videos that failed, were asked for in the last 7 days, and have not been retried (no video here
 * is a retry of them), so one put right does not stay on Home for the week. The library's Failed and "Made in the last
 * 7 days" filters list these, with any retried ones beside them.
 */
export function failedThisWeek(videos: { id: string; status: string; createdAt: string; retryOf?: string }[], now = Date.now()): number {
  const retried = new Set(videos.map((v) => v.retryOf).filter(Boolean));
  return videos.filter((v) => v.status === "failed" && madeWithin(v, "7d", now) && !retried.has(v.id)).length;
}

/** Videos waiting for a decision on their review (a workspace's "In review"), as the library's review filter lists them. */
export function awaitingReview(videos: { review?: { status: string } }[]): number {
  return videos.filter((v) => v.review?.status === "pending").length;
}

/**
 * Videos with a review note no one has resolved yet, and how many such notes there are, from the library's
 * `openComments` (by video id); only the videos it lists count, so pass the counts of every video, not of a page.
 */
export function openCommentSummary(counts: Record<string, number> | undefined): { videos: number; notes: number } {
  const values = Object.values(counts ?? {}).filter((n) => n > 0);
  return { videos: values.length, notes: values.reduce((sum, n) => sum + n, 0) };
}

/**
 * What a library card's open-comments badge says: the open notes, and of those how many mention the reader (never
 * more than are open), and when `fresh`, that some are new since the reader last opened the video; `mentions` is how
 * many it marks, 0 when none.
 */
export function openCommentsBadge(count: number, mentions?: number, fresh = false): { label: string; mentions: number } {
  const forYou = mentions && mentions > 0 ? Math.min(mentions, count) : 0;
  return {
    label: `${count} open ${count === 1 ? "comment" : "comments"}${forYou ? `, ${forYou} ${forYou === 1 ? "mentions" : "mention"} you` : ""}${fresh ? "; new since you last opened it" : ""}`,
    mentions: forYou,
  };
}

/**
 * What Home says about this month's render allowance: once a fifth of it or less is left (at least the last render), how
 * many are left and when it starts again (the 1st of next month, UTC, as the server counts); undefined with no allowance
 * or plenty left.
 */
export function allowanceNotice(used: number, limit: number | null | undefined, now = Date.now()): { left: number; used: number; limit: number; resetsAt: string } | undefined {
  if (!limit || limit <= 0) return undefined;
  const left = Math.max(0, limit - used);
  if (left > Math.max(1, Math.floor(limit / 5))) return undefined;
  const d = new Date(now);
  return { left, used, limit, resetsAt: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString() };
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

/**
 * A running time as formatSeconds shows it: to a tenth of a second under a minute (a silent scene's 1.5 seconds), to
 * the nearest second from a minute up (a renderer's 180.4 seconds reads 3m 00s).
 */
export function shownSeconds(total: number): number {
  const tenths = Math.round(total * 10) / 10;
  return tenths >= 60 ? Math.round(total) : tenths;
}

export function formatSeconds(total: number): string {
  const whole = shownSeconds(total);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
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

/** The library address's filter parameters (the ones the library reads, and a batch's results), which Clear filters takes off. */
export const LIBRARY_FILTER_PARAMS = ["batch", "skipped", "failed", "share", "status", "created", "review", "comments", "presenter", "voice", "shape", "length", "viewed"] as const;

/**
 * The library address's query without its filter parameters, as "?…" or "" when nothing else is left, or null when it
 * has none to take off (so the address need not change).
 */
export function withoutLibraryFilters(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!LIBRARY_FILTER_PARAMS.some((k) => params.has(k))) return null;
  for (const k of LIBRARY_FILTER_PARAMS) params.delete(k);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** The Avatars and Voices pages' "Use in videos" filter: either, only those some video needs, or only those none does. */
export type UseFilter = "all" | "used" | "unused";

export type PresenterSort = "default" | "used" | "name";

/**
 * The sort a page can show now: a remembered "used" waits for the counts (favourites first until they arrive, or for
 * good if they could not be read), so the list never claims an order it cannot give. The remembered choice is kept.
 */
export function shownPresenterSort(sort: PresenterSort, countsReady: boolean): PresenterSort {
  return sort === "used" && !countsReady ? "default" : sort;
}

/** A stored sort read back: one of the three, or the default for anything else (nothing stored, an old or edited value). */
export function parsePresenterSort(raw: string | null | undefined): PresenterSort {
  return raw === "used" || raw === "name" ? raw : "default";
}

/**
 * Orders the Avatars or Voices page: as listed ("default"), most videos first by the counts the "In N videos" links
 * show ("used"; ties and uncounted ones keep the listed order), or by name A–Z ("name", ignoring case and reading
 * numbers as numbers, so "Ava 2" comes before "Ava 10"). A new array; the given one is left as it is.
 */
export function sortPresenters<T extends { id: string; name: string }>(items: T[], sort: PresenterSort, inVideos: ReadonlyMap<string, number>): T[] {
  if (sort === "default") return items;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  return [...items].sort(sort === "name" ? byName : (a, b) => (inVideos.get(b.id) ?? 0) - (inVideos.get(a.id) ?? 0));
}

/**
 * Whether a presenter or voice passes the use filter, by how many videos (library and trash, see the list's `needs`)
 * need it (only videos are counted, not interactive presenters, templates, or the brand kit). A count read off an object is read as its own entry only, so an id like "constructor" is not the prototype.
 */
export function passesUse(counts: Record<string, number> | undefined, id: string, use: UseFilter): boolean {
  if (use === "all") return true;
  // Counts not read yet say nothing: never list everything as unused for want of them.
  if (!counts) return false;
  const needed = counts && Object.hasOwn(counts, id) && typeof counts[id] === "number" ? counts[id] : 0;
  return (needed > 0) === (use === "used");
}
