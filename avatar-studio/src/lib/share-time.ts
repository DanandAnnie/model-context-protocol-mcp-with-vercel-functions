/** The longest start a share link may ask for; past the video's own end the player simply starts at the beginning. */
const MAX_START_SEC = 24 * 60 * 60;

/**
 * The time a share link asks the player to start at (`?t=`), in seconds: `90`, `90s`, `12.4` (to the millisecond, as
 * a chapter's link writes it), `1m30s`, `1h2m3s`, or the clock forms `1:30` and `1:02:03`, the ways YouTube and people
 * write it. Anything else (a repeated `t`, which arrives as a list, a negative, a day or more) is no start at all, so a
 * mistyped link still plays from the beginning.
 */
export function parseStartTime(raw: unknown): number | undefined {
  return parseTime(raw);
}

/** The shortest section a link may play: an end closer than this to the start is no end at all. */
export const MIN_SECTION_SEC = 1;

/**
 * Where a share link asks the player to stop (`?end=`), in the same forms as `?t=`: the player pauses there, so the link
 * plays a section. It must come at least a second after the start (`start`, or the beginning without one); anything
 * else (not a time, before or at the start) is no end, so the link plays on to the video's own end.
 */
export function parseEndTime(raw: unknown, start?: number): number | undefined {
  const end = parseTime(raw);
  return end !== undefined && end >= (start ?? 0) + MIN_SECTION_SEC ? end : undefined;
}

/** Where a chapter's link starts, in milliseconds: rounded up to a tenth, or to the millisecond to stay before `nextMs`. */
function chapterStartMs(startMs: number, nextMs?: number): number {
  const ms = Math.ceil(startMs / 100) * 100;
  return nextMs !== undefined && ms >= nextMs ? Math.ceil(startMs) : ms;
}

/**
 * A share link that plays one chapter only: from its start (as its own link starts) to the next chapter's start, where
 * the share page pauses as the next chapter would begin. A chapter under a second long gets its plain start link.
 */
export function shareChapterLink(base: string, startMs: number, nextMs: number): string {
  return shareSectionLink(base, chapterStartMs(startMs, nextMs) / 1000, nextMs / 1000);
}

/** Whether a chapter's play-only-this-chapter link is a section at all: one under a second long gets a plain start link. */
export function chapterSectionPlays(startMs: number, nextMs: number): boolean {
  // The same test, in seconds, as shareSectionLink makes, so the two never disagree on a rounding edge.
  return nextMs / 1000 >= chapterStartMs(startMs, nextMs) / 1000 + MIN_SECTION_SEC;
}

/** A time in seconds as a link writes it: to the millisecond at most, without trailing zeros. */
function linkTime(sec: number): string {
  return String(Number(sec.toFixed(3)));
}

/**
 * A share link that plays the section from `startSec` to `endSec` (`?t=` and `?end=`); a start of 0 is left out, and an
 * end that is no end (at or before the start plus a second) leaves the link starting at `startSec` alone.
 */
export function shareSectionLink(base: string, startSec: number, endSec?: number): string {
  const start = Math.max(0, Number(startSec.toFixed(3)));
  const end = endSec !== undefined ? Number(endSec.toFixed(3)) : undefined;
  const parts = [start > 0 ? `t=${linkTime(start)}` : "", end !== undefined && end >= start + MIN_SECTION_SEC ? `end=${linkTime(end)}` : ""].filter(Boolean);
  return parts.length ? `${base}${base.includes("?") ? "&" : "?"}${parts.join("&")}` : base;
}

/** Seconds as a clock (`1:05`, `1:02:03`, `0:12.5`), the way the section fields show and accept them. */
export function clockTime(sec: number): string {
  const tenths = Math.round(sec * 10) / 10;
  const whole = Math.floor(tenths);
  const frac = Math.round((tenths - whole) * 10);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = `${String(s).padStart(2, "0")}${frac ? `.${frac}` : ""}`;
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A time typed into a section field, in any form a link takes, where zero (`0`, `0:00`) is the beginning. */
export function parseTimeInput(raw: string): number | undefined {
  return /^\s*0+(?::0+)*(?:\.0+)?s?\s*$/.test(raw) ? 0 : parseTime(raw);
}

function parseTime(raw: unknown): number | undefined {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!text) return undefined;
  let sec: number | undefined;
  const plain = /^(\d+(?:\.\d{1,3})?)s?$/.exec(text);
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  // h:mm:ss, or m:ss with any number of minutes (a long video's 75:30, as a description writes it).
  const clock = /^(?:(\d+):([0-5]?\d)|(\d+)):([0-5]\d(?:\.\d{1,3})?)$/.exec(text);
  if (plain) sec = Number(plain[1]);
  else if (units && (units[1] || units[2] || units[3])) sec = Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  else if (clock) sec = Number(clock[1] ?? 0) * 3600 + Number(clock[2] ?? clock[3]) * 60 + Number(clock[4]);
  return sec !== undefined && sec > 0 && sec < MAX_START_SEC ? sec : undefined;
}

/**
 * A share link that starts at `startMs`, at or just after it so the player lands inside that chapter rather than at the
 * end of the one before: rounded up to a tenth of a second, or to the millisecond when that would reach the next
 * chapter's start (`nextMs`). Whole seconds are written without decimals, and a start of 0 leaves the link plain.
 */
export function shareLinkAt(base: string, startMs: number, nextMs?: number): string {
  const ms = chapterStartMs(startMs, nextMs);
  if (ms <= 0) return base;
  const t = ms % 1000 === 0 ? String(ms / 1000) : String(Number((ms / 1000).toFixed(3)));
  return `${base}${base.includes("?") ? "&" : "?"}t=${t}`;
}
