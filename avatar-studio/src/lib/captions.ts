// Build an SRT subtitle file from a script and the rendered duration.
// Sentences are timed proportionally to their word count.

export interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

const MAX_CUE_CHARS = 90;

/** HeyGen writes captions into the file itself unless a caption style asks for the share page's track alone. */
export function heygenBurnsCaptions(req: { captions?: boolean; captionStyle?: unknown }): boolean {
  return !!req.captions && !req.captionStyle;
}

/** True when the rendered file already carries captions, so the share page's track must stay off until asked for. */
export function captionsBurnedIn(video: { captions?: boolean; captionStyle?: unknown; provider?: string }): boolean {
  return video.provider === "heygen" && heygenBurnsCaptions(video);
}

function splitSentences(script: string): string[] {
  const sentences = script
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  // Break very long sentences at commas so cues stay readable.
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= MAX_CUE_CHARS) {
      out.push(s);
      continue;
    }
    let current = "";
    for (const part of s.split(/(?<=,)\s+/)) {
      if ((current + " " + part).trim().length > MAX_CUE_CHARS && current) {
        out.push(current.trim());
        current = part;
      } else {
        current = (current + " " + part).trim();
      }
    }
    if (current) out.push(current.trim());
  }
  return out;
}

export function buildCues(script: string, durationSec: number): Cue[] {
  const sentences = splitSentences(script);
  const totalWords = sentences.reduce((n, s) => n + s.split(" ").length, 0);
  if (!sentences.length || totalWords === 0 || durationSec <= 0) return [];
  const totalMs = Math.round(durationSec * 1000);
  let cursor = 0;
  return sentences.map((text, i) => {
    const words = text.split(" ").length;
    const span = i === sentences.length - 1 ? totalMs - cursor : Math.round((words / totalWords) * totalMs);
    const cue = { index: i + 1, startMs: cursor, endMs: cursor + span, text };
    cursor += span;
    return cue;
  });
}

export function formatSrtTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(r, 3)}`;
}

export function formatVttTime(ms: number): string {
  return formatSrtTime(ms).replace(",", ".");
}

/** A cue setting that puts subtitles near the top of the frame; the default (bottom) needs none. */
const VTT_TOP = " line:5%";

export function buildVtt(script: string, durationSec: number, position: "bottom" | "top" = "bottom"): string {
  const setting = position === "top" ? VTT_TOP : "";
  const cues = buildCues(script, durationSec)
    .map((c) => `${c.index}\n${formatVttTime(c.startMs)} --> ${formatVttTime(c.endMs)}${setting}\n${c.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${cues}`;
}

export function buildSrt(script: string, durationSec: number): string {
  return buildCues(script, durationSec)
    .map((c) => `${c.index}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}\n`)
    .join("\n");
}
