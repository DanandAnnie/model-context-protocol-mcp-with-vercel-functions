// Turning a text or Markdown document into scenes for the editor. Pure, so the editor and the tests share it.
import { PAUSE_MARKER, stripPauses } from "./pauses";
import { MAX_SCENES } from "./types";

/** The most a video's script may hold, all scenes together, as the video schema checks it (scenes joined by a blank line). */
export const MAX_SCRIPT_CHARS = 5000;
/** The largest file the editor reads; a script document is a few kilobytes. */
export const MAX_IMPORT_BYTES = 1_000_000;
const SEPARATOR = "\n\n";

export interface ImportedScript {
  /** One script per scene, in order; together (joined by a blank line) within `MAX_SCRIPT_CHARS`. Empty when the document has no words. */
  scenes: string[];
  /** The document's top-level heading, offered as the video title. */
  title?: string;
  /** True when the document held more than a video takes (`MAX_SCENES` scenes, `MAX_SCRIPT_CHARS` characters) and the rest was left out. */
  truncated: boolean;
}

const BREAK = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const SETEXT = /^\s*(=+|-+)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
const PAUSE = new RegExp(PAUSE_MARKER, "gi");

const hasWords = (text: string) => stripPauses(text).trim().length > 0;

/** Markdown outside code spans as it would be read aloud: images and links by their text, autolinks by their address, emphasis and tags dropped. */
function spokenMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^<>\s]+|[^<>\s@]+@[^<>\s@]+)>/gi, "$1")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, "")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[\s(])[*_](?=[^*_\s])([^*_]+?)(?<=\S)[*_](?=[\s).,;:!?]|$)/g, "$1$2");
}

/** A Markdown line as it would be read aloud; code spans keep their text as written. */
function spokenLine(line: string, listItem: boolean): string {
  const text = line.replace(/^\s*>\s?/, "").replace(listItem ? LIST_ITEM : /^$/, "");
  const parts = text.split("`");
  // An unmatched backtick is just a character.
  if (parts.length % 2 === 0) parts.splice(parts.length - 2, 2, `${parts[parts.length - 2]}\`${parts[parts.length - 1]}`);
  return parts.map((p, i) => (i % 2 ? p : spokenMarkdown(p))).join("").trim();
}

/** Paragraphs of a block: runs of non-empty lines, each joined into one line. A paragraph with only pauses joins the one before it (or after it). */
function paragraphs(lines: string[], markdown: boolean): string[] {
  const out: string[] = [];
  let pending = "";
  let run: string[] = [];
  const flush = () => {
    // A line is a list item only at the start of a paragraph or right after another, so "We sold\n100. That…" keeps its number.
    let inList = false;
    const words = run
      .map((line, i) => {
        if (!markdown) return line.trim();
        inList = LIST_ITEM.test(line) && (i === 0 || inList);
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
  return out;
}

/** Where a cut at `at` would split a pause marker, the marker's start instead. */
function outsidePause(text: string, at: number): number {
  for (const m of text.matchAll(PAUSE)) {
    if (m.index! < at && at < m.index! + m[0].length) return m.index!;
  }
  return at;
}

/** A script longer than `max`, cut at sentence ends (or spaces, or anywhere as a last resort, never inside a pause) into pieces that fit. */
function fit(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
    const space = head.lastIndexOf(" ");
    let cut = sentence > max / 2 ? sentence + 1 : space > max / 2 ? space : max;
    cut = outsidePause(rest, cut) || cut;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
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

/** Leading YAML front matter (`---` … `---`) holds metadata, not script. */
function withoutFrontMatter(lines: string[]): string[] {
  if (!/^---\s*$/.test(lines[0] ?? "")) return lines;
  const end = lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(l));
  return end > 0 && lines.slice(1, end).every((l) => !l.trim() || /^[\w-]+\s*:/.test(l) || /^\s/.test(l)) ? lines.slice(end + 1) : lines;
}

/**
 * Scenes from a plain-text or Markdown document. A heading or a line of `---` (or `***`, `___`) starts a new
 * scene, and the paragraphs between are that scene's script; a document with neither (a title heading aside)
 * gets one scene per paragraph, packed together when there are more paragraphs than a video has scenes. With
 * `markdown`, list markers, emphasis, links, and tags are left out of what is spoken; plain text is taken as
 * written. A video holds `MAX_SCRIPT_CHARS` of script in all, so a longer document is cut at a sentence end and
 * the rest left out.
 */
export function scenesFromText(text: string, { markdown = true }: { markdown?: boolean } = {}): ImportedScript {
  const lines = withoutFrontMatter(text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n"));
  let title: string | undefined;
  const sections: string[][] = [[]];
  let explicit = false;
  const seenText = () => sections.some((s) => s.some((l) => l.trim()));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const atx = markdown ? HEADING.exec(line) : null;
    // A text line underlined with === is a heading too (Markdown's other spelling); with ---, only a short line that
    // is not a sentence, since "One point.\n---" is more often a scene break after a paragraph than a heading.
    const underline = SETEXT.exec(lines[i + 1] ?? "")?.[1];
    const setext =
      markdown && !atx && !!line.trim() && !BREAK.test(line) && !(lines[i - 1] ?? "").trim() && !!underline &&
      (underline.startsWith("=") || (line.trim().length <= 60 && !/[.!?:;,]$/.test(line.trim())));
    if (atx || setext) {
      const name = spokenLine(atx ? atx[2] : line, false);
      const top = atx ? atx[1] === "#" : underline!.startsWith("=");
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
  const blocks = explicit ? sections.map((s) => paragraphs(s, markdown).join(SEPARATOR)).filter(hasWords) : paragraphs(sections.flat(), markdown);

  // Keep what a video holds, in order: blocks while the whole script fits, the next one cut to the room left.
  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (const block of blocks) {
    const room = MAX_SCRIPT_CHARS - used - (kept.length ? SEPARATOR.length : 0);
    if (block.length <= room) {
      kept.push(block);
      used += block.length + (kept.length > 1 ? SEPARATOR.length : 0);
      continue;
    }
    truncated = true;
    const head = room > 0 ? fit(block, room)[0] : undefined;
    if (head && hasWords(head)) kept.push(head);
    break;
  }
  let scenes = explicit ? kept : pack(kept);
  if (scenes.length > MAX_SCENES) {
    scenes = scenes.slice(0, MAX_SCENES);
    truncated = true;
  }
  return { scenes, ...(title ? { title } : {}), truncated };
}
