/**
 * "Resume where you left off" on a share page: the place a viewer reached in a video, kept in their own browser, so
 * coming back to the same link offers to carry on from there. A plain module, so the rules can be tested without one.
 */

/** Where this browser keeps the places, one entry per video. */
export const SHARE_RESUME_KEY = "avatar-studio:share-resume";

/** A place is not worth keeping before this far in (or a quarter of a shorter video), nor offered back. */
export const RESUME_MIN_SEC = 10;
/** Nor this close to the end (or the last 15% of a shorter video): it counts as watched, and the next visit starts over. */
export const RESUME_END_SEC = 10;
/** How long a place is kept. */
export const RESUME_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** How many videos' places are kept: the most recent. */
export const RESUME_MAX = 50;

export type ResumePlaces = Record<string, { t: number; at: number }>;

/** The places kept, read from what the browser holds: anything malformed is dropped, not trusted. */
export function readPlaces(raw: string | null): ResumePlaces {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ResumePlaces = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const p = v as { t?: unknown; at?: unknown } | null;
      if (p && typeof p.t === "number" && Number.isFinite(p.t) && p.t > 0 && typeof p.at === "number" && Number.isFinite(p.at)) out[id] = { t: p.t, at: p.at };
    }
    return out;
  } catch {
    return {};
  }
}

/** Where a place counts, for a video of `durationSec` (when known): from `from` in, to before `to`. */
function limits(durationSec: number | undefined) {
  if (durationSec === undefined || !Number.isFinite(durationSec) || durationSec <= 0) return { from: RESUME_MIN_SEC, to: Infinity };
  return { from: Math.min(RESUME_MIN_SEC, durationSec * 0.25), to: durationSec - Math.min(RESUME_END_SEC, durationSec * 0.15) };
}

/**
 * The places after a viewer reaches `sec` in video `id` (of `durationSec`, when known) at `now`: kept from ten seconds
 * in, cleared in the last ten seconds (or once ended), the oldest and expired ones dropped. A short video's limits are
 * shorter: from a quarter in, cleared in its last 15%.
 */
export function placeAt(places: ResumePlaces, id: string, sec: number, durationSec: number | undefined, now: number): ResumePlaces {
  const next: ResumePlaces = {};
  for (const [k, v] of Object.entries(places)) if (k !== id && now - v.at < RESUME_KEEP_MS) next[k] = v;
  const { from, to } = limits(durationSec);
  const t = Math.floor(sec);
  if (Number.isFinite(sec) && t >= from && t > 0 && sec < to) next[id] = { t, at: now };
  const ids = Object.keys(next).sort((a, b) => next[b].at - next[a].at);
  for (const k of ids.slice(RESUME_MAX)) delete next[k];
  return next;
}

/** The place to offer for video `id` at `now`: one kept, not expired, inside the limits `placeAt` keeps it within. */
export function resumeOffer(places: ResumePlaces, id: string, durationSec: number | undefined, now: number): number | null {
  const p = places[id];
  if (!p || now - p.at >= RESUME_KEEP_MS) return null;
  const { from, to } = limits(durationSec);
  return p.t >= from && p.t < to ? p.t : null;
}
