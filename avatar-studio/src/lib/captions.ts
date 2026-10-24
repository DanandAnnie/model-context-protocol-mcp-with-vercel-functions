// Build an SRT subtitle file from a script and the rendered duration.
// Sentences are timed proportionally to their word count.

export interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

const MAX_CUE_CHARS = 90;
/** A cue in a script written without word spaces (Chinese, Japanese, Thai) is kept this short: its characters each carry more. */
const MAX_UNSPACED_CUE_CHARS = 40;
/** Marks that close a quotation or bracket and belong to the sentence before them. */
const CLOSERS = `["'”’)\\]」』）】〕》〉]`;
/** Sentence ends: Western punctuation (and any closing quote) followed by space, or an East Asian full stop, question, or exclamation mark with its closers. */
const SENTENCE_END = new RegExp(`(?<=[.!?]${CLOSERS}*)\\s+|(?<=[。！？]${CLOSERS}*)(?!${CLOSERS})`, "u");
/** Clause ends, for breaking a long sentence. */
const CLAUSE_END = /(?<=,)\s+|(?<=[，、])/u;
/** Characters of scripts written without word spaces; see `limitFor` and `weight`. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** True when most of the text is in a script written without word spaces, whether or not it happens to contain a space. */
function unspaced(text: string): boolean {
  const letters = Array.from(text).filter((c) => /[\p{L}\p{N}]/u.test(c));
  return letters.length > 0 && letters.filter((c) => UNSPACED.test(c)).length * 2 > letters.length;
}

/** How long a cue of this text may be, in characters. */
function limitFor(text: string): number {
  return unspaced(text) ? MAX_UNSPACED_CUE_CHARS : MAX_CUE_CHARS;
}

function fits(text: string): boolean {
  return Array.from(text).length <= limitFor(text);
}

/** Joins two cue pieces: no space after East Asian punctuation or between two characters of an unspaced script. */
function join(a: string, b: string): string {
  if (!a) return b;
  const tight = new RegExp(`[，、。！？]${CLOSERS}*$`, "u").test(a) || (UNSPACED.test(a.slice(-1)) && UNSPACED.test(b.charAt(0)));
  return tight ? a + b : `${a} ${b}`;
}

/** Cuts text that does not fit a cue into pieces that do: at the last space within the limit when there is one, else by character. */
function cut(text: string): string[] {
  const limit = limitFor(text);
  const out: string[] = [];
  let rest = Array.from(text);
  while (rest.length > limit) {
    const space = rest.lastIndexOf(" ", limit);
    const at = space > 0 ? space : limit;
    out.push(rest.slice(0, at).join("").trim());
    rest = rest.slice(at);
    while (rest[0] === " ") rest.shift();
  }
  if (rest.length) out.push(rest.join("").trim());
  return out.filter(Boolean);
}

/**
 * The timing weight of a cue. Spaced languages weigh a word each; a script written without
 * spaces weighs about half a word per character, which is close to how long it takes to say.
 */
function weight(text: string): number {
  return text.split(/\s+/).reduce((n, token) => n + (UNSPACED.test(token) ? Math.max(1, Array.from(token).length / 2) : 1), 0);
}

/** HeyGen writes captions into the file itself unless a caption style asks for the share page's track alone. */
export function heygenBurnsCaptions(req: { captions?: boolean; captionStyle?: unknown }): boolean {
  return !!req.captions && !req.captionStyle;
}

/** True when the rendered file already carries captions, so the share page's track must stay off until asked for. */
export function captionsBurnedIn(video: { captions?: boolean; captionStyle?: unknown; provider?: string }): boolean {
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

export function buildCues(script: string, durationSec: number): Cue[] {
  const sentences = splitSentences(script);
  const totalWords = sentences.reduce((n, s) => n + weight(s), 0);
  if (!sentences.length || totalWords === 0 || durationSec <= 0) return [];
  const totalMs = Math.round(durationSec * 1000);
  let cursor = 0;
  return sentences.map((text, i) => {
    const words = weight(text);
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
