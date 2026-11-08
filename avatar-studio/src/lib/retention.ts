/**
 * Audience retention on a share page: how many viewers started playing a video, and how many reached each tenth of it.
 * Kept as eleven counts, `[started, 10%, 20%, …, 100%]`; the share player reports the furthest point a viewer reaches and
 * the server counts every point up to it once per viewer per window, as it does the quarters. A plain module, so the
 * rules can be tested without a player or a store.
 */

/** Points counted: started (0), then each tenth up to the end (10). */
export const RETENTION_POINTS = 11;

/**
 * The furthest point a playhead at `timeSec` of `durationSec` has reached: 0 once playing has started, 1–9 at each tenth,
 * 10 only at the end (`ended`, or `nearEnd` for a looping video, which never ends).
 */
export function retentionPoint(timeSec: number, durationSec: number, opts: { ended?: boolean; nearEnd?: boolean } = {}): number {
  if (opts.ended || opts.nearEnd) return 10;
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(timeSec)) return 0;
  return Math.max(0, Math.min(9, Math.floor((timeSec / durationSec) * 10 + 1e-9)));
}

/** The counts as stored, made whole: eleven non-negative whole numbers, missing ones as 0. */
export function retentionCounts(stored?: readonly number[] | null): number[] {
  return Array.from({ length: RETENTION_POINTS }, (_, i) => {
    const n = stored?.[i];
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  });
}

/**
 * Each tenth's share of the viewers who started, as whole percents (10%…100%); none until someone has started. A later
 * point never shows more than an earlier one: a viewer who jumped ahead is counted at every point up to where they got.
 */
export function retentionShares(stored?: readonly number[] | null): { started: number; shares: number[] } | null {
  const counts = retentionCounts(stored);
  const started = counts[0];
  if (!started) return null;
  let cap = 100;
  const shares = counts.slice(1).map((n) => {
    cap = Math.min(cap, Math.round((Math.min(n, started) / started) * 100));
    return cap;
  });
  return { started, shares };
}

/**
 * Where most viewers left: the tenth whose share fell furthest below the one before it (from 100% at the start), as the
 * points either side (0 = the start, 10 = the end) and the fall in percentage points. None when nobody left anywhere.
 */
export function biggestDrop(shares: readonly number[]): { from: number; to: number; points: number } | null {
  let best: { from: number; to: number; points: number } | null = null;
  let before = 100;
  shares.forEach((share, i) => {
    const fall = before - share;
    if (fall > 0 && (!best || fall > best.points)) best = { from: i, to: i + 1, points: fall };
    before = share;
  });
  return best;
}
