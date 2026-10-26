// Turning a text or Markdown document into scenes for the editor. Pure, so the editor and the tests share it.
import { PAUSE_MARKER, stripPauses } from "./pauses";
import { MAX_SCENES } from "./types";

/** The most a video's script may hold, all scenes together, as the video schema checks it (scenes joined by a blank line). */
export const MAX_SCRIPT_CHARS = 5000;
/** The largest file the editor reads; a script document is a few kilobytes. */
export const MAX_IMPORT_BYTES = 1_000_000;
const SEPARATOR = "\n\n";
/** The shortest piece worth keeping when a cut has to fall between words rather than after a sentence. */
const MIN_PIECE = 40;
/**
 * How much of the document is read: a video keeps 5000 characters, and Markdown seldom takes more than a few
 * times that to write, so reading further only costs time (the editor runs this on the page's own thread).
 */
const READ_CHARS = MAX_SCRIPT_CHARS * 8;
const MAX_LINE_CHARS = MAX_SCRIPT_CHARS * 2;

export interface ImportedScript {
  /** One script per scene, in order; together (joined by a blank line) within `MAX_SCRIPT_CHARS`. Empty when the document has no words. */
  scenes: string[];
  /** The document's top-level heading, offered as the video title. */
  title?: string;
  /** True when the document held more than a video takes (`MAX_SCENES` scenes, `MAX_SCRIPT_CHARS` characters) and the rest was left out. */
  truncated: boolean;
}

const BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
/** Lines of only `=` or only `#` divide too, when they are not a heading's underline or a heading. */
const RULE = /^\s{0,3}(?:=+|#+)\s*$/;
const SETEXT = /^\s{0,3}=+\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/;
const ORDERED = /^\s*(\d{1,3})[.)]\s+/;
const FENCE = /^\s{0,3}(```|~~~)/;
// A link reference definition names a destination (a URL or path) and at most a quoted title; "[NARRATOR]: Welcome." is a line of script.
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(?:<[^<>]*>|[^\s<>]*[/.#:][^\s<>]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
// A table's header rule has a pipe; a bare --- is a scene break.
const TABLE_RULE = /^(?=[^|]*\|)\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const PAUSE = new RegExp(PAUSE_MARKER, "gi");
// Tags a document may use for formatting; anything else between < and > is prose ("from <1% to >5%", "a <b and c>").
const TAG = /<\/?(?:a|abbr|b|big|blockquote|br|center|cite|code|del|div|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|q|s|small|span|strike|strong|sub|sup|table|tbody|td|th|thead|tr|tt|u|ul)(?:\s+[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))*\s*\/?>/gi;
// A link destination: no spaces, one level of parentheses ("…/Mercury_(planet)"), and an optional quoted title.
const DESTINATION = String.raw`\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)`;
const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s|$)/g;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
/** Marks a line inside a code fence, to be read as written. */
const VERBATIM = "\u0001";

const hasWords = (text: string) => stripPauses(text).trim().length > 0;
// A backslash-escaped character (any ASCII punctuation, as Markdown allows) is held in the private-use area while
// Markdown is read, so `\*` is never emphasis, then given back as the character.
const hide = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/g, (_, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)));
const unhide = (text: string) => text.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));

/** Markdown outside code spans as it would be read aloud: images and links by their text, autolinks by their address, emphasis, tags, and footnote marks dropped. */
function spokenMarkdown(text: string): string {
  return text
    .replace(new RegExp(String.raw`!\[([^\]]*)\]` + DESTINATION, "g"), "$1")
    .replace(new RegExp(String.raw`\[([^\]]+)\]` + DESTINATION, "g"), "$1")
    .replace(/\[\^[^\]\s]+\]/g, "")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^<>\s]+|[^<>\s@]+@[^<>\s@]+)>/gi, "$1")
    .replace(TAG, "")
    .replace(/&(#\d{1,5}|[a-z]{2,6});/gi, (m, name: string) => (name[0] === "#" ? String.fromCharCode(Number(name.slice(1))) : (ENTITIES[name.toLowerCase()] ?? m)))
    // Emphasis within a line, each marker closed by its own kind, so an unclosed one costs no more than a scan.
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*|__(?=\S)([^_\n]+?)(?<=\S)__|~~(?=\S)([^~\n]+?)(?<=\S)~~/g, (_, a, b, c) => a ?? b ?? c)
    .replace(/(^|[\s(])([*_])(?=[^*_\s])([^*_\n]+?)(?<=\S)\2(?=[\s).,;:!?]|$)/g, "$1$3");
}

/** A Markdown line as it would be read aloud; code spans keep their text as written, a table row is read cell by cell. */
function spokenLine(line: string, listItem: boolean): string {
  let text = hide(line);
  if (listItem) text = text.replace(BULLET, "").replace(ORDERED, "");
  if (/^\s*\|/.test(text)) {
    text = text.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ");
    if (text && !/[.!?;:]$/.test(text)) text += ".";
  }
  const parts = text.split("`");
  // An unmatched backtick is just a character.
  if (parts.length % 2 === 0) parts.splice(parts.length - 2, 2, `${parts[parts.length - 2]}\`${parts[parts.length - 1]}`);
  return unhide(parts.map((p, i) => (i % 2 ? p : spokenMarkdown(p))).join("")).trim();
}

/** Paragraphs of a block: runs of non-empty lines, each joined into one line. A paragraph with only pauses joins the one before it (or after it). */
function paragraphs(lines: string[], markdown: boolean): string[] {
  const out: string[] = [];
  const pending: string[] = [];
  let run: string[] = [];
  const flush = () => {
    // A bullet is always a list item; a number only at the start of a paragraph, after another item, or as "1.",
    // so a wrapped "We sold\n100. That…" keeps its number while "Steps:\n1. Open" reads as a list.
    let inList = false;
    const words = run
      .map((raw, i) => {
        if (raw.startsWith(VERBATIM)) return raw.slice(1).trim();
        if (!markdown) return raw.trim();
        const line = raw.replace(/^\s*(?:>\s?)+/, "");
        const ordered = ORDERED.exec(line);
        inList = BULLET.test(line) || (!!ordered && (i === 0 || inList || ordered[1] === "1"));
        return spokenLine(line, inList);
      })
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    run = [];
    if (!words) return;
    if (!hasWords(words)) {
      if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${words}`;
      else pending.push(words);
      return;
    }
    out.push(pending.length ? `${pending.join(" ")} ${words}` : words);
    pending.length = 0;
  };
  for (const line of lines) {
    if (line.replace(VERBATIM, "").trim()) run.push(line);
    else flush();
  }
  flush();
  // Only pauses in the whole block: keep them, for the caller to join to a neighbour.
  if (!out.length && pending.length) out.push(pending.join(" "));
  return out;
}

/** Whether a cut at `at` would split a pause marker (markers are short, so only the text around the cut is looked at). */
function insidePause(text: string, at: number): boolean {
  const from = Math.max(0, at - 24);
  for (const m of text.slice(from, at + 24).matchAll(PAUSE)) {
    const start = from + m.index!;
    if (start < at && at < start + m[0].length) return true;
  }
  return false;
}

/**
 * The longest start of `text` within `max` characters that ends a sentence or a paragraph, or between words
 * (outside a pause marker) when no such end comes in the second half of the room; undefined when there is none.
 * Only the first `max` characters are looked at, so a huge paragraph costs no more than a short one.
 */
function head(text: string, max: number): string | undefined {
  if (text.length <= max) return text;
  const window = text.slice(0, max + 1);
  let sentence = -1;
  for (const m of window.matchAll(SENTENCE_END)) if (m.index! + m[0].length <= max) sentence = m.index! + m[0].length;
  sentence = Math.max(sentence, window.lastIndexOf(SEPARATOR, max));
  let word = -1;
  for (let i = Math.min(max, window.length - 1); i >= MIN_PIECE; i--) {
    if (/\s/.test(window[i]) && !insidePause(text, i)) {
      word = i;
      break;
    }
  }
  // A sentence end wins unless it would keep less than half the room and a cut between words keeps more.
  const cut = sentence > 0 && (sentence >= max / 2 || word <= sentence) ? sentence : word;
  const piece = cut > 0 ? text.slice(0, cut).trim() : "";
  return piece && hasWords(piece) ? piece : undefined;
}

/** Paragraphs packed in order into at most `MAX_SCENES` scenes of about even length; joining keeps the separator, so the total is unchanged. */
function pack(paras: string[]): string[] {
  if (paras.length <= MAX_SCENES) return paras;
  const total = paras.join(SEPARATOR).length;
  const target = Math.ceil(total / MAX_SCENES);
  const scenes: string[] = [];
  let current = "";
  paras.forEach((p, i) => {
    // Close a scene once it reaches the target, unless the rest would no longer fit in the scenes left.
    const left = paras.length - i;
    if (current && (current.length >= target || left <= MAX_SCENES - scenes.length - 1) && scenes.length < MAX_SCENES - 1) {
      scenes.push(current);
      current = p;
    } else {
      current = current ? `${current}${SEPARATOR}${p}` : p;
    }
  });
  if (current) scenes.push(current);
  return scenes;
}

/** Leading YAML front matter (`---`, lowercase `key: value` lines, `---`) holds metadata, not script. */
function withoutFrontMatter(lines: string[]): string[] {
  if (!/^---\s*$/.test(lines[0] ?? "")) return lines;
  const end = lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(l));
  if (end < 2) return lines;
  const body = lines.slice(1, end);
  return body.some((l) => /^[a-z_][\w-]*\s*:/.test(l)) && body.every((l) => !l.trim() || /^[a-z_][\w-]*\s*:/.test(l) || /^\s+\S/.test(l)) ? lines.slice(end + 1) : lines;
}

/** Blocks with only pauses join their neighbour (the one before, or else the one after), so no scene is a pause alone. */
function joinPauseOnly(blocks: string[]): string[] {
  const out: string[] = [];
  const pending: string[] = [];
  for (const block of blocks) {
    if (hasWords(block)) {
      out.push(pending.length ? `${pending.join(" ")} ${block}` : block);
      pending.length = 0;
    } else if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${block}`;
    else pending.push(block);
  }
  return out;
}

/**
 * Scenes from a plain-text or Markdown document. A heading or a line of `---` (or `***`, `___`) starts a new
 * scene, and the paragraphs between are that scene's script; a document with neither (a title heading aside)
 * gets one scene per paragraph, packed together when there are more paragraphs than a video has scenes. With
 * `markdown`, list markers, emphasis, links, tags, comments, link definitions, and footnote marks are left out of
 * what is spoken, and code inside fences is read as written; plain text is taken as written. A video holds
 * `MAX_SCRIPT_CHARS` of script in all, so a longer document is cut at a sentence end and the rest left out.
 */
export function scenesFromText(text: string, { markdown = true }: { markdown?: boolean } = {}): ImportedScript {
  let source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (markdown) source = source.replace(/<!--[\s\S]*?-->/g, "");
  let lines = source.split("\n");
  if (markdown) lines = withoutFrontMatter(lines);
  let title: string | undefined;
  const sections: string[][] = [[]];
  let explicit = false;
  let seen = false;
  let read = 0;
  let cutShort = false;
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    // Reading stops well past what a video keeps; the rest could only be left out.
    if (read > READ_CHARS) {
      cutShort = true;
      break;
    }
    let line = lines[i];
    if (line.length > MAX_LINE_CHARS) {
      line = line.slice(0, MAX_LINE_CHARS);
      cutShort = true;
    }
    read += line.length + 1;
    if (markdown) {
      const opens = FENCE.exec(line);
      if (fence) {
        if (opens && opens[1] === fence) fence = undefined;
        else {
          sections[sections.length - 1].push(VERBATIM + line);
          if (line.trim()) seen = true;
        }
        continue;
      }
      if (opens) {
        fence = opens[1];
        continue;
      }
      if (LINK_DEFINITION.test(line) || TABLE_RULE.test(line)) continue;
    }
    const atx = markdown ? HEADING.exec(line) : null;
    // A text line underlined with === is a heading too (Markdown's other spelling); a list item, quote, or table row is not.
    const setext = markdown && !atx && !!line.trim() && SETEXT.test(lines[i + 1] ?? "") && !(lines[i - 1] ?? "").trim() && !/^\s*(?:[-*+>|]|\d{1,3}[.)]\s)/.test(line);
    if (atx || setext) {
      const name = spokenLine(atx ? atx[2] : line, false);
      const top = atx ? atx[1] === "#" : true;
      if (setext) i++;
      // A title before any script names the video; it does not divide the document into scenes.
      if (top && !title && !seen && name) {
        title = name.slice(0, 120);
        continue;
      }
      explicit = true;
      sections.push([]);
    } else if (BREAK.test(line) || (markdown && RULE.test(line))) {
      explicit = true;
      sections.push([]);
    } else {
      sections[sections.length - 1].push(line);
      if (line.trim()) seen = true;
    }
  }
  const blocks = joinPauseOnly(explicit ? sections.map((s) => paragraphs(s, markdown).join(SEPARATOR)).filter(Boolean) : paragraphs(sections.flat(), markdown));

  // Keep what a video holds, in order: blocks while the whole script fits, the next one cut to the room left.
  const kept: string[] = [];
  let used = 0;
  let truncated = cutShort;
  for (const block of blocks) {
    const room = MAX_SCRIPT_CHARS - used - (kept.length ? SEPARATOR.length : 0);
    if (block.length <= room) {
      used += block.length + (kept.length ? SEPARATOR.length : 0);
      kept.push(block);
      continue;
    }
    truncated = true;
    const piece = room > 0 ? head(block, room) : undefined;
    if (piece) kept.push(piece);
    break;
  }
  let scenes = explicit ? kept : pack(kept);
  if (scenes.length > MAX_SCENES) {
    scenes = scenes.slice(0, MAX_SCENES);
    truncated = true;
  }
  return { scenes, ...(title ? { title } : {}), truncated };
}
