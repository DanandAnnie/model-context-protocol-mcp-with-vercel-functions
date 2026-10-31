/** The longest start a share link may ask for; past the video's own end the player simply starts at the beginning. */
const MAX_START_SEC = 24 * 60 * 60;

/**
 * The time a share link asks the player to start at (`?t=`), in seconds: `90`, `90s`, `12.4` (to the millisecond, as
 * a chapter's link writes it), `1m30s`, `1h2m3s`, or the clock forms `1:30` and `1:02:03`, the ways YouTube and people
 * write it. Anything else (a repeated `t`, which arrives as a list, a negative, a day or more) is no start at all, so a
 * mistyped link still plays from the beginning.
 */
export function parseStartTime(raw: unknown): number | undefined {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!text) return undefined;
  let sec: number | undefined;
  const plain = /^(\d+(?:\.\d{1,3})?)s?$/.exec(text);
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  const clock = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/.exec(text);
  if (plain) sec = Number(plain[1]);
  else if (units && (units[1] || units[2] || units[3])) sec = Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  else if (clock) sec = Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  return sec !== undefined && sec > 0 && sec < MAX_START_SEC ? sec : undefined;
}

/**
 * A share link that starts at `startMs`, at or just after it so the player lands inside that chapter rather than at the
 * end of the one before: rounded up to a tenth of a second, or to the millisecond when that would reach the next
 * chapter's start (`nextMs`). Whole seconds are written without decimals, and a start of 0 leaves the link plain.
 */
export function shareLinkAt(base: string, startMs: number, nextMs?: number): string {
  let ms = Math.ceil(startMs / 100) * 100;
  if (nextMs !== undefined && ms >= nextMs) ms = Math.ceil(startMs);
  if (ms <= 0) return base;
  const t = ms % 1000 === 0 ? String(ms / 1000) : String(Number((ms / 1000).toFixed(3)));
  return `${base}${base.includes("?") ? "&" : "?"}t=${t}`;
}
