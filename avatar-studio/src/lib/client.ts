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
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * What an email carries for a shared video: its animated preview (a fixed address that redirects to the renderer's GIF,
 * or to the cover) linked to the share page, as HTML for a mail client, and the bare link for one that pastes text.
 */
export function emailSnippet(video: { id: string; title: string; aspect?: string }, base: string): { html: string; text: string } {
  const share = `${base.replace(/\/$/, "")}/share/${video.id}`;
  const width = video.aspect === "9:16" ? 270 : video.aspect === "1:1" ? 360 : 480;
  const alt = escapeHtml(`Watch the video: ${video.title}`);
  const html = `<a href="${escapeHtml(share)}"><img src="${escapeHtml(`${share}/preview.gif`)}" alt="${alt}" width="${width}" style="display:block;max-width:100%;height:auto;border:0"></a>`;
  return { html, text: share };
}

/** True once a share link's expiry has passed. */
export function shareExpired(video: { shareExpiresAt?: string }, now = Date.now()): boolean {
  return !!video.shareExpiresAt && Date.parse(video.shareExpiresAt) <= now;
}

/** True while the public should see "not found": the owner switched the link off, it expired, or the video is in the trash. */
export function shareOffline(video: { shareDisabled?: boolean; shareExpiresAt?: string; deletedAt?: string }, now = Date.now()): boolean {
  return !!video.shareDisabled || !!video.deletedAt || shareExpired(video, now);
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
