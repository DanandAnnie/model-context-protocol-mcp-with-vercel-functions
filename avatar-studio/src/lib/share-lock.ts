// Password protection for share links. The password is never stored: a salted scrypt hash lives
// in its own store record (never returned by the video routes), and a visitor who enters the
// right password gets a cookie derived from that hash, so changing or removing the password
// invalidates every cookie at once.
import { createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { timingSafeEqual } from "./auth";
import { nowIso } from "./ids";
import { getStore } from "./store";
import type { Video } from "./types";

export type ShareLock = { id: string; ownerId?: string; salt: string; hash: string; createdAt: string };

export const SHARE_PASSWORD_MIN = 4;
export const SHARE_PASSWORD_MAX = 64;
/** How long an unlocked visitor stays unlocked. */
export const SHARE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function scrypt(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, 32, (err, key) => (err ? reject(err) : resolve(key.toString("hex"))));
  });
}

export async function setShareLock(video: Pick<Video, "id" | "ownerId">, password: string): Promise<ShareLock> {
  const salt = randomBytes(16).toString("hex");
  const lock: ShareLock = { id: video.id, ownerId: video.ownerId, salt, hash: await scrypt(password, salt), createdAt: nowIso() };
  return getStore().put("sharelock", lock);
}

export function clearShareLock(videoId: string): Promise<void> {
  return getStore().remove("sharelock", videoId);
}

export function getShareLock(videoId: string): Promise<ShareLock | null> {
  return getStore().get<ShareLock>("sharelock", videoId);
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
  return createHash("sha256").update(`avatar-studio:share:${lock.id}:${lock.hash}`).digest("hex");
}

/** True when the video has no password, or `cookie` is the value handed out for its current password. */
export async function shareUnlocked(video: Pick<Video, "id" | "shareLocked">, cookie: string | undefined): Promise<boolean> {
  if (!video.shareLocked) return true;
  const lock = await getShareLock(video.id);
  if (!lock) return true;
  return !!cookie && timingSafeEqual(cookie, shareCookieValue(lock));
}
