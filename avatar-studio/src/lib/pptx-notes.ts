// Reading a PowerPoint deck (.pptx) for its words: each slide's speaker notes, which HeyGen's PowerPoint import uses
// as the presenter's script, and the slide's own text as a fallback. Only the deck's XML parts are unpacked (never
// its pictures or media), and it runs the same in the browser and in tests.
import { strFromU8, unzipSync } from "fflate";

export interface PptxSlide {
  /** The speaker notes, one line per paragraph; empty when the slide has none. */
  notes: string;
  /** The text on the slide itself (titles, bullets, text boxes), one line per paragraph. */
  text: string;
  /** Hidden in the slide show; PowerPoint leaves these out when it saves the deck as PDF. */
  hidden: boolean;
}

/** The characters XML escapes, and numeric references (curly quotes and dashes arrive as those too). */
function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The paragraphs of a run of DrawingML, each the joined text of its runs; line breaks inside one become spaces. */
function paragraphs(xml: string): string[] {
  const out: string[] = [];
  for (const p of xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) ?? []) {
    const runs = (p.match(/<a:t(?:\s[^>]*)?>[\s\S]*?<\/a:t>|<a:br\b[^>]*\/>/g) ?? []).map((r) => (r.startsWith("<a:br") ? " " : unescapeXml(r.replace(/^<a:t(?:\s[^>]*)?>|<\/a:t>$/g, ""))));
    const line = runs.join("").replace(/\s+/g, " ").trim();
    if (line) out.push(line);
  }
  return out;
}

/** The shapes of a slide or notes page, each with its placeholder type when it has one. */
function shapes(xml: string): Array<{ type: string | null; body: string }> {
  return (xml.match(/<p:sp[\s>][\s\S]*?<\/p:sp>/g) ?? []).map((sp) => ({ type: /<p:ph\b[^>]*\btype="([^"]+)"/.exec(sp)?.[1] ?? (/<p:ph\b/.test(sp) ? "body" : null), body: sp }));
}

/** Relationship id → target path, resolved against the folder of the part the relationships belong to. */
function relationships(xml: string | undefined, folder: string): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  for (const rel of xml?.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = /\bId="([^"]+)"/.exec(rel)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(rel)?.[1];
    const type = /\bType="([^"]+)"/.exec(rel)?.[1] ?? "";
    if (id && target && !/\bTargetMode="External"/.test(rel)) map.set(id, { target: resolvePath(folder, unescapeXml(target)), type });
  }
  return map;
}

/** `ppt/slides` + `../notesSlides/notesSlide1.xml` → `ppt/notesSlides/notesSlide1.xml`; a leading slash is from the package root. */
function resolvePath(folder: string, target: string): string {
  const parts = target.startsWith("/") ? [] : folder.split("/").filter(Boolean);
  for (const seg of target.replace(/^\//, "").split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/**
 * The slides of a .pptx in presentation order (hidden slides included and marked, as PowerPoint numbers them), with
 * their speaker notes and text. Throws a readable error for a file that is not a PowerPoint deck (a .ppt from before 2007, a renamed
 * file, a broken zip).
 */
export function readPptx(bytes: Uint8Array, name = "The file"): PptxSlide[] {
  let files: Record<string, Uint8Array>;
  try {
    // Only the parts with words and links: a deck's pictures and video can be most of its size.
    files = unzipSync(bytes, { filter: (f) => /^(ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/(_rels\/)?slide\d+\.xml(\.rels)?|notesSlides\/notesSlide\d+\.xml))$/.test(f.name) });
  } catch {
    throw new Error(`${name} could not be read as a PowerPoint (.pptx) file; save it as .pptx or PDF`);
  }
  const text = (path: string) => (files[path] ? strFromU8(files[path]) : undefined);
  const presentation = text("ppt/presentation.xml");
  if (!presentation) throw new Error(`${name} is not a PowerPoint (.pptx) deck; save it as .pptx or PDF`);
  const rels = relationships(text("ppt/_rels/presentation.xml.rels"), "ppt");
  const order = [...(presentation.match(/<p:sldId\b[^>]*\/?>/g) ?? [])].map((tag) => /\br:id="([^"]+)"/.exec(tag)?.[1]).filter((id): id is string => !!id);
  const slides: PptxSlide[] = [];
  for (const rid of order) {
    const slidePath = rels.get(rid)?.target;
    const slideXml = slidePath ? text(slidePath) : undefined;
    if (!slidePath || !slideXml) continue;
    const folder = slidePath.slice(0, slidePath.lastIndexOf("/"));
    const file = slidePath.slice(slidePath.lastIndexOf("/") + 1);
    const slideRels = relationships(text(`${folder}/_rels/${file}.rels`), folder);
    const notesPath = [...slideRels.values()].find((r) => r.type.endsWith("/notesSlide"))?.target;
    const notesXml = notesPath ? text(notesPath) : undefined;
    // On a notes page, the notes are the body placeholder; the slide picture, header, date, and number are not.
    const notes = notesXml ? shapes(notesXml).filter((s) => s.type === "body").flatMap((s) => paragraphs(s.body)) : [];
    // On the slide, every shape's text but the footer, date, and slide number.
    const onSlide = shapes(slideXml).filter((s) => !["ftr", "dt", "sldNum"].includes(s.type ?? "")).flatMap((s) => paragraphs(s.body));
    const hidden = /<p:sld\b[^>]*\bshow="(0|false)"/.test(slideXml);
    slides.push({ notes: notes.join("\n"), text: onSlide.join("\n"), hidden });
  }
  if (!slides.length) throw new Error(`${name} has no slides`);
  return slides;
}
