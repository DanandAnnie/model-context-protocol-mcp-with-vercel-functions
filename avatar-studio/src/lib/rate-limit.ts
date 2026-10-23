// Small fixed-window rate limiter kept in process memory. Good enough to blunt
// password guessing on a single instance; on serverless hosts each instance has
// its own window, so treat it as defence in depth rather than a hard guarantee.
//
// The client key comes from X-Forwarded-For, which hosting platforms set but a
// direct client can forge, so callers should pair the per-client limit with the
// global one (see `rateLimitPair`).

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const PRUNE_ABOVE = 500;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSec: number;
}

function prune(now: number) {
  if (buckets.size <= PRUNE_ABOVE) return;
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  prune(now);
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  const allowed = b.count <= limit;
  return { allowed, remaining: Math.max(0, limit - b.count), retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
}

/**
 * Per-client limit plus a global backstop under the same window, so forged
 * client identities cannot bypass the limit entirely. Returns the stricter result.
 */
export function rateLimitPair(clientKey: string, clientLimit: number, globalKey: string, globalLimit: number, windowMs: number, now = Date.now()): RateLimitResult {
  const a = rateLimit(clientKey, clientLimit, windowMs, now);
  const b = rateLimit(globalKey, globalLimit, windowMs, now);
  if (!a.allowed) return a;
  if (!b.allowed) return b;
  return a.remaining <= b.remaining ? a : b;
}

/** Forget a key, e.g. after a successful sign-in. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
