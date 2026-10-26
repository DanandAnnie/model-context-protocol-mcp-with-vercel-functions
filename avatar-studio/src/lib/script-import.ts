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

export interface ImportedScript {
  /** One script per scene, in order; together (joined by a blank line) within `MAX_SCRIPT_CHARS`. Empty when the document has no words. */
  scenes: string[];
  /** The document's top-level heading, offered as the video title. */
  title?: string;
  /** True when the document held more than a video takes (`MAX_SCENES` scenes, `MAX_SCRIPT_CHARS` characters) and the rest was left out. */
  truncated: boolean;
}

const BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const SETEXT = /^\s{0,3}=+\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^\s*[-*+]\s+/;
const ORDERED = /^\s*(\d{1,3})[.)]\s+/;
const FENCE = /^\s{0,3}(?:```|~~~)/;
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S+/;
// A table's header rule has a pipe; a bare --- is a scene break.
const TABLE_RULE = /^(?=[^|]*\|)\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const PAUSE = new RegExp(PAUSE_MARKER, "gi");
// Tags a document may use for formatting; anything else between < and > is prose ("from <1% to >5%", "a <b and c>").
const TAG = /<\/?(?:a|abbr|b|big|blockquote|br|center|cite|code|del|div|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|q|s|small|span|strike|strong|sub|sup|table|tbody|td|th|thead|tr|tt|u|ul)(?:\s+[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))*\s*\/?>/gi;
const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s|$)/g;

const hasWords = (text: string) => stripPauses(text).trim().length > 0;
// A backslash-escaped character is held in the private-use area while Markdown is read, so `\*` is never emphasis.
const hide = (text: string) => text.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, (_, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)));
const unhide = (text: string) => text.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));

/** Markdown outside code spans as it would be read aloud: images and links by their text, autolinks by their address, emphasis and tags dropped. */
function spokenMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^<>\s]+|[^<>\s@]+@[^<>\s@]+)>/gi, "$1")
    .replace(TAG, "")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[\s(])[*_](?=[^*_\s])([^*_]+?)(?<=\S)[*_](?=[\s).,;:!?]|$)/g, "$1$2");
}

/** A Markdown line as it would be read aloud; code spans keep their text as written, table cells are read in turn. */
function spokenLine(line: string, listItem: boolean): string {
  let text = hide(line).replace(/^\s*>\s?/, "");
  if (listItem) text = text.replace(BULLET, "").replace(ORDERED, "");
  if (/^\s*\|/.test(text)) text = text.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ");
  const parts = text.split("`");
  // An unmatched backtick is just a character.
  if (parts.length % 2 === 0) parts.splice(parts.length - 2, 2, `${parts[parts.length - 2]}\`${parts[parts.length - 1]}`);
  return unhide(parts.map((p, i) => (i % 2 ? p : spokenMarkdown(p))).join("")).trim();
}

/** Paragraphs of a block: runs of non-empty lines, each joined into one line. A paragraph with only pauses joins the one before it (or after it). */
function paragraphs(lines: string[], markdown: boolean): string[] {
  const out: string[] = [];
  let pending = "";
  let run: string[] = [];
  const flush = () => {
    // A bullet is always a list item; a number only at the start of a paragraph, after another item, or as "1.",
    // so a wrapped "We sold\n100. That…" keeps its number while "Steps:\n1. Open" reads as a list.
    let inList = false;
    const words = run
      .map((line, i) => {
        if (!markdown) return line.trim();
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
      else pending = `${pending} ${words}`.trim();
      return;
    }
    out.push(pending ? `${pending} ${words}` : words);
    pending = "";
  };
  for (const line of lines) {
    if (line.trim()) run.push(line);
    else flush();
  }
  flush();
  // Only pauses in the whole block: keep them, for the caller to join to a neighbour.
  if (!out.length && pending) out.push(pending);
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
 * The longest start of `text` within `max` characters that ends a sentence or a paragraph, or failing that ends
 * between words (outside a pause marker) and is at least `MIN_PIECE` long; undefined when there is none. Only the
 * first `max` characters are looked at, so a huge paragraph costs no more than a short one.
 */
function head(text: string, max: number): string | undefined {
  if (text.length <= max) return text;
  const window = text.slice(0, max + 1);
  let cut = -1;
  for (const m of window.matchAll(SENTENCE_END)) if (m.index! + m[0].length <= max) cut = m.index! + m[0].length;
  const paragraph = window.lastIndexOf(SEPARATOR, max);
  if (paragraph > cut) cut = paragraph;
  if (cut <= 0) {
    for (let i = Math.min(max, window.length - 1); i >= MIN_PIECE; i--) {
      if (/\s/.test(window[i]) && !insidePause(text, i)) {
        cut = i;
        break;
      }
    }
  }
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
  let pending = "";
  for (const block of blocks) {
    if (hasWords(block)) {
      out.push(pending ? `${pending} ${block}` : block);
      pending = "";
    } else if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${block}`;
    else pending = `${pending} ${block}`.trim();
  }
  return out;
}

/**
 * Scenes from a plain-text or Markdown document. A heading or a line of `---` (or `***`, `___`) starts a new
 * scene, and the paragraphs between are that scene's script; a document with neither (a title heading aside)
 * gets one scene per paragraph, packed together when there are more paragraphs than a video has scenes. With
 * `markdown`, list markers, emphasis, links, tags, comments, code fences, and link definitions are left out of
 * what is spoken; plain text is taken as written. A video holds `MAX_SCRIPT_CHARS` of script in all, so a longer
 * document is cut at a sentence end and the rest left out.
 */
export function scenesFromText(text: string, { markdown = true }: { markdown?: boolean } = {}): ImportedScript {
  let source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (markdown) source = source.replace(/<!--[\s\S]*?-->/g, "");
  let lines = source.split("\n");
  if (markdown) lines = withoutFrontMatter(lines).filter((l) => !FENCE.test(l) && !LINK_DEFINITION.test(l) && !TABLE_RULE.test(l));
  let title: string | undefined;
  const sections: string[][] = [[]];
  let explicit = false;
  const seenText = () => sections.some((s) => s.some((l) => l.trim()));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const atx = markdown ? HEADING.exec(line) : null;
    // A text line underlined with === is a heading too (Markdown's other spelling); a list item, quote, or table row is not.
    const setext = markdown && !atx && !!line.trim() && SETEXT.test(lines[i + 1] ?? "") && !(lines[i - 1] ?? "").trim() && !/^\s*(?:[-*+>|]|\d{1,3}[.)]\s)/.test(line);
    if (atx || setext) {
      const name = spokenLine(atx ? atx[2] : line, false);
      const top = atx ? atx[1] === "#" : true;
      if (setext) i++;
      // A title before any script names the video; it does not divide the document into scenes.
      if (top && !title && !seenText() && name) {
        title = name.slice(0, 120);
        continue;
      }
      explicit = true;
      sections.push([]);
    } else if (BREAK.test(line)) {
      explicit = true;
      sections.push([]);
    } else {
      sections[sections.length - 1].push(line);
    }
  }
  const blocks = joinPauseOnly(explicit ? sections.map((s) => paragraphs(s, markdown).join(SEPARATOR)).filter(Boolean) : paragraphs(sections.flat(), markdown));

  // Keep what a video holds, in order: blocks while the whole script fits, the next one cut to the room left.
  const kept: string[] = [];
  let used = 0;
  let truncated = false;
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
