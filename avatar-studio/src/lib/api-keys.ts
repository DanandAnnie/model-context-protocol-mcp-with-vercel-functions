// Personal API keys for programmatic access. The secret is shown once and only its hash is stored.
import { createHash, randomBytes } from "node:crypto";
import { UnauthorizedError } from "./errors";
import { newId, nowIso } from "./ids";
import { getStore } from "./store";
import type { ApiKey } from "./types";

import { API_KEY_PREFIX } from "./auth";
export { API_KEY_PREFIX };
export const MAX_API_KEYS = 10;
/** The lifetimes a key can be given when it is made, in days; a key given none never expires. */
export const KEY_LIFETIMES = [30, 90, 365] as const;
export type KeyLifetime = (typeof KEY_LIFETIMES)[number];
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Public view of a key: never includes the hash. */
export function publicKey(key: ApiKey): Omit<ApiKey, "hash"> {
  const { hash: _hash, ...rest } = key;
  void _hash;
  return rest;
}

/** The keys as Settings lists them, newest first, each saying whether it has expired by the server's clock. */
export async function listApiKeys(ownerId: string, now = Date.now()): Promise<Array<Omit<ApiKey, "hash"> & { expired: boolean }>> {
  const keys = await getStore().list<ApiKey>("apikey", ownerId);
  keys.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return keys.map((k) => ({ ...publicKey(k), expired: apiKeyExpired(k, now) }));
}

/** Creates a key and returns the one-time secret alongside its public record. */
export async function createApiKey(name: string, ownerId: string, createdBy: string = ownerId, expiresInDays?: KeyLifetime): Promise<{ key: Omit<ApiKey, "hash">; secret: string }> {
  const existing = await getStore().list<ApiKey>("apikey", ownerId);
  if (existing.length >= MAX_API_KEYS) throw new Error(`At most ${MAX_API_KEYS} API keys per account; revoke one first`);
  const secret = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const key: ApiKey = {
    id: newId("key"),
    ownerId,
    name,
    prefix: secret.slice(0, API_KEY_PREFIX.length + 6),
    hash: hashApiKey(secret),
    createdBy,
    createdAt: nowIso(),
    ...(expiresInDays ? { expiresAt: new Date(Date.now() + expiresInDays * 86_400_000).toISOString() } : {}),
  };
  await getStore().put("apikey", key);
  return { key: publicKey(key), secret };
}

export async function revokeApiKey(id: string, ownerId: string): Promise<boolean> {
  const key = await getStore().get<ApiKey>("apikey", id);
  if (!key || key.ownerId !== ownerId) return false;
  await getStore().remove("apikey", id);
  return true;
}

/** Whether a key's lifetime has run out. */
export function apiKeyExpired(key: Pick<ApiKey, "expiresAt">, now = Date.now()): boolean {
  return !!key.expiresAt && Date.parse(key.expiresAt) <= now;
}

/**
 * Owner id for a presented secret, or null when it is unknown or revoked; recording its last use. An expired key throws
 * an UnauthorizedError with its own message (401) instead, so a script's owner knows to make a new one rather than look
 * for a typo, and its last use is left as it was.
 */
export async function ownerForApiKey(secret: string): Promise<string | null> {
  if (!secret.startsWith(API_KEY_PREFIX)) return null;
  const key = await getStore().findBy<ApiKey>("apikey", "hash", hashApiKey(secret));
  if (!key) return null;
  if (apiKeyExpired(key)) throw new UnauthorizedError(`This API key expired on ${key.expiresAt!.slice(0, 16).replace("T", " ")} UTC; create a new one in Settings`);
  // Best effort, at most once a minute per key: a failed or skipped timestamp write never blocks the request.
  if (!key.lastUsedAt || Date.now() - Date.parse(key.lastUsedAt) > LAST_USED_WRITE_INTERVAL_MS) {
    getStore().put("apikey", { ...key, lastUsedAt: nowIso() }).catch(() => {});
  }
  return key.ownerId;
}

/**
 * Revokes every key of an owner, or only those minted by one person. Used when a member leaves a
 * workspace (their keys must not outlive their membership) and when a workspace is deleted.
 */
export async function revokeApiKeysFor(ownerId: string, createdBy?: string): Promise<number> {
  const keys = await getStore().list<ApiKey>("apikey", ownerId);
  let n = 0;
  for (const key of keys) {
    if (createdBy && (key.createdBy ?? key.ownerId) !== createdBy) continue;
    await getStore().remove("apikey", key.id);
    n += 1;
  }
  return n;
}
