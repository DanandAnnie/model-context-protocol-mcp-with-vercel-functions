// Build an SRT subtitle file from a script and the rendered duration.
// Sentences are timed proportionally to their word count.
import { splitAtPauses } from "./pauses";

export interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

const MAX_CUE_CHARS = 90;
/** A cue in a script written without word spaces (Chinese, Japanese, Thai), or read at that density (Korean), is kept this short: its characters each carry more. */
const MAX_UNSPACED_CUE_CHARS = 40;
/** Marks that close a quotation or bracket and belong to the sentence before them. */
const CLOSERS = `["'”’)\\]」』）】〕》〉]`;
/** Sentence ends: Western punctuation (and any closing quote) followed by space, or an East Asian full stop, question, or exclamation mark with its closers. */
const SENTENCE_END = new RegExp(`(?<=[.!?]${CLOSERS}*)\\s+|(?<=[。！？]${CLOSERS}*)(?!${CLOSERS})`, "u");
/** Text that is nothing but sentence or clause marks and closers. */
const ONLY_MARKS = new RegExp(`^(?:[.!?,，、。！？]|${CLOSERS})+$`, "u");
/** Clause ends, for breaking a long sentence. */
const CLAUSE_END = /(?<=,)\s+|(?<=[，、])/u;
/** Characters of scripts written without word spaces (or, for Korean, read at that density); see `width` and `weight`. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** How much of a cue one character of an unspaced script takes up, measured in Latin characters. */
const UNSPACED_CHAR_WIDTH = MAX_CUE_CHARS / MAX_UNSPACED_CUE_CHARS;

/**
 * The room a text takes up in a cue: a Latin character counts one, a character of a script written
 * without word spaces counts more, so a mixed sentence is judged by what it carries rather than by
 * which script is in the majority.
 */
function width(text: string): number {
  let w = 0;
  for (const c of text) w += UNSPACED.test(c) ? UNSPACED_CHAR_WIDTH : 1;
  return w;
}

function fits(text: string): boolean {
  return width(text) <= MAX_CUE_CHARS;
}

/** Whether a character belongs to a script written without word spaces (or, for Korean, read at that density). */
export function isUnspaced(char: string): boolean {
  return UNSPACED.test(char);
}

/** Joins two cue pieces: no space after East Asian punctuation or between two characters of an unspaced script. */
function join(a: string, b: string): string {
  if (!a) return b;
  const tight = new RegExp(`[，、。！？]${CLOSERS}*$`, "u").test(a) || (UNSPACED.test(Array.from(a).at(-1) ?? "") && UNSPACED.test(Array.from(b)[0] ?? ""));
  return tight ? a + b : `${a} ${b}`;
}

/** Cuts text that does not fit a cue (`room` wide) into pieces that do: at the last space within the room when there is one, else by character. */
function cut(text: string, room = MAX_CUE_CHARS): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    for (let w = 0; end < chars.length; end++) {
      w += UNSPACED.test(chars[end]) ? UNSPACED_CHAR_WIDTH : 1;
      if (w > room) break;
    }
    if (end === chars.length) {
      out.push(chars.slice(start).join("").trim());
      break;
    }
    const space = chars.lastIndexOf(" ", end);
    const at = space > start ? space : end;
    out.push(chars.slice(start, at).join("").trim());
    start = at;
    while (chars[start] === " ") start++;
  }
  const pieces = out.filter(Boolean);
  // A full stop or closing quote left over on its own belongs to the cue it ends; one mark over the room is better than a cue of punctuation.
  const last = pieces[pieces.length - 1];
  if (pieces.length > 1 && ONLY_MARKS.test(last)) pieces.splice(pieces.length - 2, 2, pieces[pieces.length - 2] + last);
  return pieces;
}

/**
 * The timing weight of a cue. Spaced languages weigh a word each; a script written without
 * spaces weighs about half a word per character, which is close to how long it takes to say.
 */
function weight(text: string): number {
  return text.split(/\s+/).reduce((n, token) => n + (UNSPACED.test(token) ? Math.max(1, Array.from(token).length / 2) : 1), 0);
}

/** How many words a script (its pause markers already taken out) takes to say, counted as caption timing counts them. */
export function spokenWords(text: string): number {
  const t = text.trim();
  return t ? weight(t) : 0;
}

/**
 * HeyGen writes captions into the file itself unless a caption style asks for the share page's track alone, or the
 * video is transparent (nothing is burned over the alpha).
 */
export function heygenBurnsCaptions(req: { captions?: boolean; captionStyle?: unknown; transparent?: true }): boolean {
  return !!req.captions && !req.captionStyle && !req.transparent;
}

/** True when the rendered file already carries captions, so the share page's track must stay off until asked for. */
export function captionsBurnedIn(video: { captions?: boolean; captionStyle?: unknown; transparent?: true; provider?: string }): boolean {
  return video.provider === "heygen" && heygenBurnsCaptions(video);
}

function splitSentences(script: string): string[] {
  const sentences = script.replace(/\s+/g, " ").trim().split(SENTENCE_END).map((s) => s.trim()).filter(Boolean);
  // A sentence too long for one cue is broken at its clause marks, the clauses joined back up to
  // the cue limit, and a clause that is still too long (or a script with no marks at all, like
  // Thai) cut at its spaces or, failing those, by character.
  const out: string[] = [];
  for (const s of sentences) {
    if (fits(s)) {
      out.push(s);
      continue;
    }
    let current = "";
    for (const clause of s.split(CLAUSE_END).map((c) => c.trim()).filter(Boolean)) {
      const joined = join(current, clause);
      if (fits(joined)) {
        current = joined;
        continue;
      }
      if (current) out.push(current);
      if (fits(clause)) {
        current = clause;
      } else {
        // The last piece of a cut clause may still take the next clause.
        const pieces = cut(clause);
        current = pieces.pop() ?? "";
        out.push(...pieces);
      }
    }
    if (current) out.push(current);
  }
  return out;
}

/**
 * Cues for a script timed to a running time: sentences share the spoken time by their weight, and a
 * pause marker between them leaves a gap as long as the pause (pauses never take more than `maxPauseShare` of
 * the running time, half unless the caller already counted them in it, so a short render still shows every line). Markers never appear in the cue text.
 */
export function buildCues(script: string, durationSec: number, maxPauseShare = 0.5): Cue[] {
  const parts = splitAtPauses(script).map((p) => ({ sentences: splitSentences(p.text), pauseSec: p.pauseSec }));
  const totalWords = parts.reduce((n, p) => n + p.sentences.reduce((m, s) => m + weight(s), 0), 0);
  if (totalWords === 0 || durationSec <= 0) return [];
  const totalMs = Math.round(durationSec * 1000);
  // A pause before the first line delays it and one after the last ends the captions early; pauses between lines are gaps.
  const firstPart = parts.findIndex((p) => p.sentences.length);
  const lastPart = parts.length - 1 - [...parts].reverse().findIndex((p) => p.sentences.length);
  const gapMs = parts.map((p, i) => (i >= firstPart && i < lastPart ? p.pauseSec * 1000 : 0));
  const leadMs = parts.slice(0, firstPart).reduce((n, p) => n + p.pauseSec * 1000, 0);
  const tailMs = parts.slice(lastPart).reduce((n, p) => n + p.pauseSec * 1000, 0);
  const pausesMs = gapMs.reduce((n, g) => n + g, 0) + leadMs + tailMs;
  const scale = pausesMs > totalMs * maxPauseShare ? (totalMs * maxPauseShare) / pausesMs : 1;
  const speechMs = totalMs - Math.round(pausesMs * scale);
  const cues: Cue[] = [];
  let cursor = Math.round(leadMs * scale);
  parts.forEach((part, pi) => {
    part.sentences.forEach((text, si) => {
      const words = weight(text);
      const isLast = pi === lastPart && si === part.sentences.length - 1;
      // Each cue ends where its share of the spoken time runs out, so rounding never drifts.
      const end = isLast ? totalMs - Math.round(tailMs * scale) : Math.round(cursor + (words / totalWords) * speechMs);
      cues.push({ index: cues.length + 1, startMs: cursor, endMs: Math.max(end, cursor + 1), text });
      cursor = cues[cues.length - 1].endMs;
    });
    cursor += Math.round(gapMs[pi] * scale);
  });
  return cues;
}

/** Room in a caption timed by its words: two short lines. */
const MAX_TIMED_CUE_CHARS = 64;
/** Longest a caption timed by its words stays up, and the silence that starts a new one. */
const MAX_TIMED_CUE_MS = 6_000;
const TIMED_GAP_MS = 600;
/** How long a caption timed by its words stays up at least, while the next one has not begun. */
const MIN_TIMED_CUE_MS = 700;
/** A word that ends a sentence, with any closing quote or bracket. */
const ENDS_SENTENCE = new RegExp(`[.!?…。！？]${CLOSERS}*$`, "u");

/**
 * Captions for speech whose words' times are known (text spoken in a voice): words are put together in the order they
 * were said into short lines (64 characters, an unspaced script's characters counting wider, a word too long for one
 * line cut into pieces sharing its time), a new one after a sentence ends, after a silence, or when the line is full
 * or has been up long enough. Each line shows from its first word to its last, a little longer when it would flash,
 * and never overlaps the next. Words of scripts written without spaces are joined without one.
 */
export function wordCues(words: Array<{ text: string; startSec: number; endSec: number }>): Cue[] {
  const pieces: Array<{ text: string; startMs: number; endMs: number }> = [];
  for (const w of words) {
    const text = w.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const startMs = Math.round(w.startSec * 1000);
    const endMs = Math.max(startMs, Math.round(w.endSec * 1000));
    const parts = width(text) > MAX_TIMED_CUE_CHARS ? cut(text, MAX_TIMED_CUE_CHARS) : [text];
    const total = parts.reduce((n, part) => n + width(part), 0);
    let at = startMs;
    parts.forEach((part, i) => {
      const end = i === parts.length - 1 ? endMs : Math.round(at + ((endMs - startMs) * width(part)) / total);
      pieces.push({ text: part, startMs: at, endMs: end });
      at = end;
    });
  }
  const lines: Array<{ text: string; startMs: number; endMs: number }> = [];
  let line: { text: string; startMs: number; endMs: number } | null = null;
  let endsSentence = false;
  for (const p of pieces) {
    const joined: string = line ? join(line.text, p.text) : p.text;
    if (line && (endsSentence || p.startMs - line.endMs >= TIMED_GAP_MS || width(joined) > MAX_TIMED_CUE_CHARS || p.endMs - line.startMs > MAX_TIMED_CUE_MS)) {
      lines.push(line);
      line = null;
    }
    line = line ? { text: joined, startMs: line.startMs, endMs: Math.max(line.endMs, p.endMs) } : { ...p };
    endsSentence = ENDS_SENTENCE.test(p.text);
  }
  if (line) lines.push(line);
  // Each line starts no earlier than the one before ends and ends by the time the next starts.
  const cues: Cue[] = [];
  let prevEnd = 0;
  lines.forEach((l, i) => {
    const startMs = Math.max(l.startMs, prevEnd);
    const next = lines[i + 1]?.startMs ?? Infinity;
    const endMs = Math.max(startMs + 1, Math.min(Math.max(l.endMs, startMs + MIN_TIMED_CUE_MS), next));
    cues.push({ index: i + 1, startMs, endMs, text: l.text });
    prevEnd = endMs;
  });
  return cues;
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

/** A cue's text on its own lines: a blank line would end the cue early in both formats. */
function cueLines(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}

/**
 * Cue text for WebVTT, where `<` opens a tag, `&` an entity, and a line holding `-->` starts a new cue:
 * escaping the three keeps whatever a line says as text, so it can neither add cues nor lose words.
 */
function vttText(text: string): string {
  return cueLines(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Cue text for SRT, where a line holding `-->` reads as a new timing line; the arrow is written as a single character instead. */
function srtText(text: string): string {
  return cueLines(text).replace(/-->/g, "→");
}

/** WebVTT for a list of cues (generated or edited). */
export function cuesToVtt(cues: Array<Omit<Cue, "index">>, position: "bottom" | "top" = "bottom"): string {
  const setting = position === "top" ? VTT_TOP : "";
  const body = cues.map((c, i) => `${i + 1}\n${formatVttTime(c.startMs)} --> ${formatVttTime(c.endMs)}${setting}\n${vttText(c.text)}\n`).join("\n");
  return `WEBVTT\n\n${body}`;
}

/** SRT for a list of cues (generated or edited). */
export function cuesToSrt(cues: Array<Omit<Cue, "index">>): string {
  return cues.map((c, i) => `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${srtText(c.text)}\n`).join("\n");
}

export function buildVtt(script: string, durationSec: number, position: "bottom" | "top" = "bottom"): string {
  return cuesToVtt(buildCues(script, durationSec), position);
}

export function buildSrt(script: string, durationSec: number): string {
  return cuesToSrt(buildCues(script, durationSec));
}

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const srtMs = (m: RegExpExecArray) => ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, "0"));

/**
 * Cues from an SRT file: each block's timing line and the text lines under it (a numbered line before the
 * timing is optional). Blocks without a readable timing, or without text, are skipped.
 */
export function parseSrt(srt: string): Array<{ startMs: number; endMs: number; text: string }> {
  const out: Array<{ startMs: number; endMs: number; text: string }> = [];
  const blocks = srt.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [from, to] = lines[at].split("-->");
    const start = SRT_TIME.exec(from);
    const end = SRT_TIME.exec(to ?? "");
    if (!start || !end) continue;
    const text = lines.slice(at + 1).map((l) => l.trim()).filter(Boolean).join("\n");
    if (!text) continue;
    out.push({ startMs: srtMs(start), endMs: Math.max(srtMs(end), srtMs(start) + 1), text });
  }
  return out;
}
