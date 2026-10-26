// Turning a text or Markdown document into scenes for the editor. Pure, so the editor and the tests share it.
import { MAX_SCENES } from "./types";

/** The most a scene's script may hold, as the video schema checks it. */
export const MAX_SCENE_CHARS = 5000;
/** The largest file the editor reads; a script document is a few kilobytes. */
export const MAX_IMPORT_BYTES = 1_000_000;

export interface ImportedScript {
  /** One script per scene, in order, each within `MAX_SCENE_CHARS`; empty when the document has no words. */
  scenes: string[];
  /** The document's first top-level heading, offered as the video title. */
  title?: string;
  /** True when the document held more than `MAX_SCENES` scenes' worth and the rest was left out. */
  truncated: boolean;
}

const BREAK = /^\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** A Markdown line as it would be read aloud: list markers, quotes, emphasis, code ticks, and link targets removed. */
function spoken(line: string): string {
  return line
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** Paragraphs of a block: runs of non-empty lines, each joined into one line. */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    const text = run.map(spoken).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
    run = [];
  };
  for (const line of lines) {
    if (line.trim()) run.push(line);
    else flush();
  }
  flush();
  return out;
}

/** A script longer than a scene takes, cut at sentence ends (or spaces, or anywhere as a last resort) into pieces that fit. */
function fit(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > MAX_SCENE_CHARS) {
    const head = rest.slice(0, MAX_SCENE_CHARS);
    const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf(".\n"));
    const space = head.lastIndexOf(" ");
    const cut = sentence > MAX_SCENE_CHARS / 2 ? sentence + 1 : space > MAX_SCENE_CHARS / 2 ? space : MAX_SCENE_CHARS;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Paragraphs packed in order into at most `MAX_SCENES` scenes, as evenly as the scene size allows. */
function pack(paras: string[]): string[] {
  if (paras.length <= MAX_SCENES) return paras;
  const total = paras.reduce((n, p) => n + p.length, 0);
  const target = Math.min(MAX_SCENE_CHARS, Math.ceil(total / MAX_SCENES));
  const scenes: string[] = [];
  let current = "";
  for (const p of paras) {
    const joined = current ? `${current}\n\n${p}` : p;
    if (current && (joined.length > MAX_SCENE_CHARS || (current.length >= target && scenes.length < MAX_SCENES - 1))) {
      scenes.push(current);
      current = p;
    } else {
      current = joined;
    }
  }
  if (current) scenes.push(current);
  return scenes;
}

/**
 * Scenes from a plain-text or Markdown document. A line of `---` (or `***`, `___`, `===`) or a heading starts
 * a new scene, and the paragraphs between are that scene's script; a document with neither gets one scene per
 * paragraph, packed together when there are more paragraphs than a video has scenes. Headings themselves are
 * not spoken; the first top-level one is offered as the title.
 */
export function scenesFromText(text: string): ImportedScript {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  let title: string | undefined;
  const sections: string[][] = [[]];
  let explicit = false;
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      if (!title && heading[1] === "#" && spoken(heading[2])) title = spoken(heading[2]).slice(0, 120);
      explicit = true;
      sections.push([]);
    } else if (BREAK.test(line)) {
      explicit = true;
      sections.push([]);
    } else {
      sections[sections.length - 1].push(line);
    }
  }
  const blocks = explicit
    ? sections.map((s) => paragraphs(s).join("\n\n")).filter(Boolean)
    : pack(paragraphs(sections[0]));
  const scenes = blocks.flatMap(fit);
  return { scenes: scenes.slice(0, MAX_SCENES), ...(title ? { title } : {}), truncated: scenes.length > MAX_SCENES };
}
