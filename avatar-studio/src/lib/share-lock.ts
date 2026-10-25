// Password protection for share links. The password is never stored: a salted scrypt hash lives
// in its own store record (never returned by the video routes), and a visitor who enters the
// right password gets a cookie derived from that hash, so changing or removing the password
// invalidates every cookie at once.
import { createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { timingSafeEqual } from "./auth";
import { nowIso } from "./ids";
import { getStore } from "./store";
import type { Video } from "./types";

export type ShareLock = { id: string; videoId: string; ownerId?: string; salt: string; hash: string; createdAt: string };

/**
 * Every kind shares one table keyed by id alone in Supabase, so the lock must not reuse the
 * video's id (it would overwrite the video row); prefixed like the plan, brand, and prefs records.
 */
export const shareLockId = (videoId: string) => `sharelock_${videoId}`;

export const SHARE_PASSWORD_MIN = 4;
export const SHARE_PASSWORD_MAX = 64;
/** The cookie that marks a viewer who passed a video's email gate. It is a courtesy, not a lock: the gate collects emails, it does not protect the video. */
export const shareGateCookieName = (videoId: string) => `as_gate_${videoId.replace(/[^A-Za-z0-9_-]/g, "")}`;
/** How long an unlocked visitor stays unlocked. */
export const SHARE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function scrypt(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, 32, (err, key) => (err ? reject(err) : resolve(key.toString("hex"))));
  });
}

export async function setShareLock(video: Pick<Video, "id" | "ownerId">, password: string): Promise<ShareLock> {
  const salt = randomBytes(16).toString("hex");
  const lock: ShareLock = { id: shareLockId(video.id), videoId: video.id, ownerId: video.ownerId, salt, hash: await scrypt(password, salt), createdAt: nowIso() };
  return getStore().put("sharelock", lock);
}

export function clearShareLock(videoId: string): Promise<void> {
  return getStore().remove("sharelock", shareLockId(videoId));
}

export function getShareLock(videoId: string): Promise<ShareLock | null> {
  return getStore().get<ShareLock>("sharelock", shareLockId(videoId));
}

/** The lock when `password` opens it, else null (also null when the video has no lock). */
export async function verifySharePassword(videoId: string, password: string): Promise<ShareLock | null> {
  const lock = await getShareLock(videoId);
  if (!lock) return null;
  return timingSafeEqual(await scrypt(password, lock.salt), lock.hash) ? lock : null;
}

export function shareCookieName(videoId: string): string {
  return `share_${videoId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** Derived from the stored hash, so it reveals nothing about the password and dies with it. */
export function shareCookieValue(lock: ShareLock): string {
  return createHash("sha256").update(`avatar-studio:share:${lock.videoId}:${lock.hash}`).digest("hex");
}

/**
 * True when the video has no password, or `cookie` is the value handed out for its current
 * password. A video marked locked whose lock record is missing stays closed: that is the state a
 * half-finished save leaves behind, and nobody should get in on the strength of it.
 */
export async function shareUnlocked(video: Pick<Video, "id" | "shareLocked">, cookie: string | undefined): Promise<boolean> {
  if (!video.shareLocked) return true;
  const lock = await getShareLock(video.id);
  if (!lock) return false;
  return !!cookie && timingSafeEqual(cookie, shareCookieValue(lock));
}
