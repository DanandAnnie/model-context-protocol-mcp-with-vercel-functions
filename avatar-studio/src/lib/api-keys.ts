// Personal API keys for programmatic access. The secret is shown once and only its hash is stored.
import { createHash, randomBytes } from "node:crypto";
import { newId, nowIso } from "./ids";
import { getStore } from "./store";
import type { ApiKey } from "./types";

export const API_KEY_PREFIX = "as_live_";
export const MAX_API_KEYS = 10;

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Public view of a key: never includes the hash. */
export function publicKey(key: ApiKey): Omit<ApiKey, "hash"> {
  const { hash: _hash, ...rest } = key;
  void _hash;
  return rest;
}

export async function listApiKeys(ownerId: string): Promise<Omit<ApiKey, "hash">[]> {
  const keys = await getStore().list<ApiKey>("apikey", ownerId);
  keys.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return keys.map(publicKey);
}

/** Creates a key and returns the one-time secret alongside its public record. */
export async function createApiKey(name: string, ownerId: string): Promise<{ key: Omit<ApiKey, "hash">; secret: string }> {
  const existing = await getStore().list<ApiKey>("apikey", ownerId);
  if (existing.length >= MAX_API_KEYS) throw new Error(`At most ${MAX_API_KEYS} API keys per account; revoke one first`);
  const secret = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const key: ApiKey = {
    id: newId("key"),
    ownerId,
    name,
    prefix: secret.slice(0, API_KEY_PREFIX.length + 6),
    hash: hashApiKey(secret),
    createdAt: nowIso(),
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

/** Owner id for a presented secret, or null when it is unknown or revoked. Records last use. */
export async function ownerForApiKey(secret: string): Promise<string | null> {
  if (!secret.startsWith(API_KEY_PREFIX)) return null;
  const key = await getStore().findBy<ApiKey>("apikey", "hash", hashApiKey(secret));
  if (!key) return null;
  // Best effort: a failed timestamp write must not block the request.
  getStore().put("apikey", { ...key, lastUsedAt: nowIso() }).catch(() => {});
  return key.ownerId;
}
