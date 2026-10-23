// Small fixed-window rate limiter kept in process memory. Good enough to blunt
// password guessing on a single instance; on serverless hosts each instance has
// its own window, so treat it as defence in depth rather than a hard guarantee.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSec: number;
}

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }
  b.count += 1;
  const allowed = b.count <= limit;
  return { allowed, remaining: Math.max(0, limit - b.count), retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
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
