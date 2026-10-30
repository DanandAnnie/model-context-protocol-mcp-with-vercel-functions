// Turning a written conversation ("Alex: Welcome back. / Sam: Thanks for having me.") into scenes, one per turn,
// each spoken by its speaker's presenter and voice. Pure, so the editor and the tests share it.
import { foldTerm } from "./glossary";
import { MAX_SCRIPT_CHARS, head } from "./script-import";
import { MAX_SCENES } from "./types";

/** The most speakers a conversation may have: each is cast with a presenter and a voice of their own. */
export const MAX_SPEAKERS = 6;
/** The most a conversation box takes: a video keeps 5000 characters of script, so more is never needed. */
export const MAX_DIALOGUE_CHARS = MAX_SCRIPT_CHARS * 4;
/** The longest name read as a speaker's ("Dr. Maya Chen-Ortiz" fits; a sentence before a colon does not). */
const MAX_NAME_CHARS = 32;
/** The most words in a speaker's name, so "The plan for today: …" is a line of script, not a speaker. */
const MAX_NAME_WORDS = 4;

export interface DialogueTurn {
  /** The speaker's name as first written. */
  speaker: string;
  /** What they say, the lines of one turn joined by a line break. */
  text: string;
}

export interface Dialogue {
  /** Each speaker once, by first appearance; a name is the same speaker in any case or Unicode form. */
  speakers: string[];
  /** One turn per scene, in order; a speaker's lines in a row are one turn. Within `MAX_SCENES` and `MAX_SCRIPT_CHARS`. */
  turns: DialogueTurn[];
  /** Lines before the first speaker's name, left out (a title, say, or a note to the reader). */
  skipped: number;
  /** Stage directions in parentheses left out so they are not spoken: a line of only one ("(laughs)"), or one that opens a turn. */
  directions: number;
  /** True when the conversation held more than a video takes and the rest was left out. */
  truncated: boolean;
}

// A line that starts with a name and a colon: "Alex: Hi.", "ALEX: Hi.", "**Alex:** Hi.", "**Alex**: Hi.", "*Alex:* Hi.",
// "[Alex]: Hi.", "- Alex: Hi.", "1. Alex: Hi.", "ALEX (V.O.): Hi." (the note in parentheses is left out), a transcript's
// "[00:01:15] Alex: Hi." or "00:01 Alex: Hi." (the time is left out), and a full-width colon ("アレックス：こんにちは").
// After an ASCII colon a space (or the line's end) must follow, so "https://…", "10:30", and "3:1" are never names.
const LABEL = /^\s*(?:\[?\d{1,2}(?::\d{2}){1,2}\]?\s+)?(?:(?:[-*>]|\d{1,3}[.)])\s+)?(\*\*|__|\*|_)?\[?([^\s:：*_[\]()][^:：*_[\]()]*?)\]?(?:\s*\([^()]*\))?(?:\1)?\s*(?::(?=(?:\1)?(?:\s|$))|：)(?:\1)?\s*(.*)$/u;
/** Words a name may hold in lower case ("Ludwig van Beethoven", "Ana de Armas"); every other word starts with a capital. */
const PARTICLES = new Set(["al", "bin", "da", "das", "de", "del", "della", "der", "di", "dos", "du", "el", "la", "le", "van", "von", "y"]);
/** A line that is only a stage direction: "(laughs)", "(Both turn to the camera.)". */
const DIRECTION = /^\s*\([^()]*\)\s*$/;

/** A speaker's name from a label, or null when what is before the colon is not a name. */
function speakerName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name || name.length > MAX_NAME_CHARS || name.split(" ").length > MAX_NAME_WORDS) return null;
  // A name has a letter in it ("Q", "Speaker 2", "Ana"), and does not end a sentence ("Note this.:" is prose).
  if (!/\p{L}/u.test(name) || /[.!?…,;]$/.test(name.replace(/\b(?:Dr|Mr|Mrs|Ms|Mx|Prof|Sr|Jr|St)\.$/i, ""))) return null;
  // Each word starts with a capital, a digit, or a letter of a script without case ("Speaker 2", "マヤ"), so a line of
  // prose before a colon ("Here's the thing: …", "Remember this: …") is never taken for a name. The first word always does.
  const words = name.split(" ");
  const capital = (w: string) => /^[\p{Lu}\p{Lt}\p{Lo}\p{N}]/u.test(w.replace(/^[^\p{L}\p{N}]+/u, ""));
  if (!capital(words[0]) || !words.slice(1).every((w) => capital(w) || PARTICLES.has(w))) return null;
  return name;
}

/**
 * Reads a conversation: each line that starts with a name and a colon begins a turn, and the lines after it, until the
 * next name, carry on that turn. A speaker's lines in a row are one turn. Lines before the first name and lines of
 * only a stage direction in parentheses are left out (and counted), as is a direction that opens a turn. The turns are
 * kept within a video's scenes and characters; a turn that does not fit whole is cut where a scene of an imported
 * script would be (after a sentence, else between words, never inside a pause marker), and the rest is left out.
 */
export function parseDialogue(input: string): Dialogue {
  const text = input.replace(/^\ufeff/, "").slice(0, MAX_DIALOGUE_CHARS);
  const speakers: string[] = [];
  const byKey = new Map<string, string>();
  const turns: Array<{ speaker: string; lines: string[] }> = [];
  let skipped = 0;
  let directions = 0;
  for (const line of text.split(/\r\n?|\n/)) {
    if (!line.trim()) continue;
    if (DIRECTION.test(line)) {
      directions++;
      continue;
    }
    const m = LABEL.exec(line);
    const name = m ? speakerName(m[2]) : null;
    if (m && name) {
      const key = foldTerm(name);
      let speaker = byKey.get(key);
      if (!speaker) {
        speaker = name;
        byKey.set(key, name);
        speakers.push(name);
      }
      // A stage direction that opens the turn ("Alex: (smiling) Welcome back.") is not spoken either.
      const opening = /^\([^()]*\)\s*/.exec(m[3].trim());
      if (opening) directions++;
      const said = m[3].trim().slice(opening?.[0].length ?? 0);
      const last = turns[turns.length - 1];
      if (last?.speaker === speaker) {
        if (said) last.lines.push(said);
      } else {
        turns.push({ speaker, lines: said ? [said] : [] });
      }
    } else if (turns.length) {
      turns[turns.length - 1].lines.push(line.trim());
    } else {
      skipped++;
    }
  }
  // A name with nothing said after it (until the next name) is not a turn; it stays a speaker only if it speaks elsewhere.
  const said = turns.filter((t) => t.lines.length).map((t) => ({ speaker: t.speaker, text: t.lines.join("\n") }));
  // Two turns of one speaker can meet once an empty turn between them is gone: they are one turn.
  const merged: DialogueTurn[] = [];
  for (const t of said) {
    const last = merged[merged.length - 1];
    if (last?.speaker === t.speaker) last.text += `\n${t.text}`;
    else merged.push({ ...t });
  }
  const kept: DialogueTurn[] = [];
  let used = 0;
  let truncated = false;
  for (const t of merged) {
    if (kept.length >= MAX_SCENES) {
      truncated = true;
      break;
    }
    // The video's scripts are joined by a blank line when its length is checked.
    const room = MAX_SCRIPT_CHARS - used - (kept.length ? 2 : 0);
    const fitted = room > 0 ? head(t.text, room) : undefined;
    if (fitted !== t.text) truncated = true;
    if (fitted) {
      used += fitted.length + (kept.length ? 2 : 0);
      kept.push({ speaker: t.speaker, text: fitted });
    }
    if (truncated) break;
  }
  if (text.length < input.replace(/^\ufeff/, "").length) truncated = true;
  return { speakers: speakers.filter((s) => kept.some((t) => t.speaker === s)), turns: kept, skipped, directions, truncated };
}
