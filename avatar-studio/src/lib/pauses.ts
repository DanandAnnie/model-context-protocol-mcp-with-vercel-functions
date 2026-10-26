// Pauses written into a script as `[pause]` (one second) or `[pause 1.5s]` (up to ten seconds). The stored
// script keeps the marker so an edit or a copy brings it back; the renderer gets it as a break it
// understands, and captions, transcripts, excerpts, and search never show it.

export const DEFAULT_PAUSE_SEC = 1;
export const MAX_PAUSE_SEC = 10;

/** `[pause]`, `[pause 2s]`, `[pause 1.5s]`, `[pause 0,5s]`, any case, with optional spaces inside the brackets. */
const PAUSE = /\[\s*pause(?:\s+(\d{1,2}(?:[.,]\d{1,2})?)\s*s?)?\s*\]/gi;
/** The marker pattern without its group or flags, for callers that must step over markers in a larger pattern. */
export const PAUSE_MARKER = /\[\s*pause(?:\s+\d{1,2}(?:[.,]\d{1,2})?\s*s?)?\s*\]/.source;

/** The length of one marker in seconds, the default when it names none, capped at the maximum. */
function seconds(raw: string | undefined): number {
  if (!raw) return DEFAULT_PAUSE_SEC;
  const n = Number(raw.replace(",", "."));
  return Math.min(MAX_PAUSE_SEC, Math.max(0.1, Number.isFinite(n) ? n : DEFAULT_PAUSE_SEC));
}

/** True when the text holds at least one pause marker. */
export function hasPauses(text: string): boolean {
  PAUSE.lastIndex = 0;
  const found = PAUSE.test(text);
  PAUSE.lastIndex = 0;
  return found;
}

/** The text without its markers, the gap each leaves closed up (a marker between words keeps one space). */
export function stripPauses(text: string): string {
  if (!hasPauses(text)) return text;
  return text
    .replace(PAUSE, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,!?;:])/g, "$1")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
}

/** How long the markers in a text pause for, in seconds. */
export function pauseSeconds(text: string): number {
  let total = 0;
  for (const m of text.matchAll(PAUSE)) total += seconds(m[1]);
  return total;
}

/** A scene of nothing but pauses is a silent one (the presenter holds for that long), up to this many seconds. */
export const MAX_SILENT_SEC = 60;

/** How long a silent scene (one holding only pause markers) lasts, or 0 for a scene with words. */
export function silentSeconds(script: string): number {
  return script.trim() && !stripPauses(script).trim() ? pauseSeconds(script) : 0;
}

/** The text cut at its markers: each piece of speech and the pause that follows it (0 after the last). */
export function splitAtPauses(text: string): Array<{ text: string; pauseSec: number }> {
  const out: Array<{ text: string; pauseSec: number }> = [];
  let last = 0;
  for (const m of text.matchAll(PAUSE)) {
    out.push({ text: text.slice(last, m.index), pauseSec: seconds(m[1]) });
    last = m.index! + m[0].length;
  }
  out.push({ text: text.slice(last), pauseSec: 0 });
  return out;
}

/** Seconds as a break tag wants them: `1s`, `1.5s`. */
const breakTime = (sec: number) => `${Math.round(sec * 100) / 100}s`;

/** The longest single break each engine honours; a longer pause is written as several breaks in a row. */
export const ELEVENLABS_MAX_BREAK_SEC = 3;
export const MICROSOFT_MAX_BREAK_SEC = 5;

/** Break tags adding up to `sec`, none longer than `maxBreakSec`. */
function breaks(sec: number, maxBreakSec: number): string {
  const out: string[] = [];
  for (let left = sec; left > 0.001; left -= maxBreakSec) out.push(`<break time="${breakTime(Math.min(left, maxBreakSec))}"/>`);
  return out.join(" ");
}

/**
 * The text with each marker as `<break time="…"/>` tags, the form HeyGen's and ElevenLabs' text input
 * takes; a pause longer than `maxBreakSec` becomes several breaks so the engine keeps the whole silence.
 */
export function withBreakTags(text: string, maxBreakSec = ELEVENLABS_MAX_BREAK_SEC): string {
  if (!hasPauses(text)) return text;
  return text.replace(PAUSE, (_m, raw: string | undefined) => ` ${breaks(seconds(raw), maxBreakSec)} `).replace(/[ \t]{2,}/g, " ").trim();
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * The text as an SSML fragment, everything escaped and each marker as breaks of at most five seconds: the
 * form D-ID's Microsoft voices take with `ssml: true` (D-ID adds the `<speak>` and `<voice>` around it).
 */
export function toSsml(text: string): string {
  return splitAtPauses(text)
    .map((p) => escapeXml(p.text) + (p.pauseSec ? breaks(p.pauseSec, MICROSOFT_MAX_BREAK_SEC) : ""))
    .join("");
}

/**
 * Swaps each marker for a numbered token a writing model leaves alone (`[[P1]]`), so a rewrite or a
 * translation cannot turn `[pause 2s]` into words that get spoken; `restore` puts the markers back and
 * drops a token the model made up. A marker the model left out is gone, which reads better than a stray one.
 */
export function protectPauses(text: string): { text: string; restore: (out: string) => string } {
  const markers: string[] = [];
  const guarded = text.replace(PAUSE, (m) => {
    markers.push(m.replace(/\s+/g, " "));
    return `[[P${markers.length}]]`;
  });
  return {
    text: guarded,
    restore: (out) => out.replace(/\[\[\s*P(\d+)\s*\]\]/g, (_m, n: string) => markers[Number(n) - 1] ?? "").replace(/[ \t]{2,}/g, " ").trim(),
  };
}
