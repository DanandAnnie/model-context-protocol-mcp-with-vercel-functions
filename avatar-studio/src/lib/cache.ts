// Tiny in-memory memo with a TTL for provider list calls (avatars, voices), which are slow and
// rarely change. Per instance; a cold start simply refetches.
const entries = new Map<string, { value: unknown; expiresAt: number; pending?: Promise<unknown> }>();

export async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now && hit.pending === undefined) return hit.value as T;
  if (hit?.pending) return hit.pending as Promise<T>;
  const pending = fn()
    .then((value) => {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .catch((err) => {
      entries.delete(key);
      throw err;
    });
  entries.set(key, { value: undefined, expiresAt: 0, pending });
  return pending;
}

export function forgetMemo(prefix = ""): void {
  for (const k of entries.keys()) if (k.startsWith(prefix)) entries.delete(k);
}
