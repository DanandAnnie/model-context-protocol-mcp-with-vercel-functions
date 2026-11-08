// Reading a Word document (.docx) as a script, like HeyGen's script upload: its paragraphs in order, a heading
// starting a new scene, and the first title (before any text) offered as the video's title. Only the document's
// XML and its style list are unpacked (never its pictures), and it runs the same in the browser and in tests.
import { strFromU8, unzipSync } from "fflate";
import { unescapeXml } from "./xml-text";

export interface DocxScript {
  /** Plain text: paragraphs separated by a blank line, and a `---` line where a heading starts a new part. */
  text: string;
  /** The document's title: a Title (or first top-level heading) paragraph before any other text. */
  title?: string;
}

/** A paragraph style: its built-in name (English whatever the language, e.g. "heading 1"), outline level, and parent. */
interface Style {
  name?: string;
  outline?: number;
  basedOn?: string;
}

/**
 * The outermost `<w:tag …>…</w:tag>` elements of `xml`, counting nesting, so a table inside a table cell (or a
 * content control inside another) stays inside its parent. Self-closing ones are included; a `w:tblPr` or `w:sdtPr`
 * is never mistaken for its parent, as the tag must end at the name.
 */
function outermost(xml: string, tag: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  for (const m of xml.matchAll(new RegExp(String.raw`<(\/?)w:${tag}(?=[\s>/])[^>]*?(\/?)>`, "g"))) {
    const at = m.index ?? 0;
    if (m[2]) {
      if (depth === 0) found.push({ start: at, end: at + m[0].length });
    } else if (m[1]) {
      if (depth > 0 && --depth === 0) found.push({ start, end: at + m[0].length });
    } else if (depth++ === 0) start = at;
  }
  return found;
}

/** An element's content, without its own opening and closing tags (nothing for a self-closing one). */
const inner = (element: string) => (/^<[^>]*\/>$/.test(element) ? "" : element.replace(/^<[^>]*>/, "").replace(/<\/[^>]*>$/, ""));

/**
 * Content controls unwrapped to their content, except the ones nothing was typed into (a template's "Click or tap
 * here to enter text.") and tables of contents, which are left out.
 */
function unwrapContentControls(xml: string): string {
  let out = "";
  let from = 0;
  for (const { start, end } of outermost(xml, "sdt")) {
    out += xml.slice(from, start);
    from = end;
    const sdt = xml.slice(start, end);
    const props = /<w:sdtPr\b[\s\S]*?<\/w:sdtPr>/.exec(sdt)?.[0] ?? "";
    const placeholder = /<w:showingPlcHdr\b(?![^>]*\bw:val="(?:0|false|off)")[^>]*\/?>/.test(props);
    const contents = /<w:docPartGallery\b[^>]*\bw:val="Table of Contents"/i.test(props);
    if (placeholder || contents) continue;
    const content = outermost(sdt, "sdtContent")[0];
    if (content) out += unwrapContentControls(inner(sdt.slice(content.start, content.end)));
  }
  return out + xml.slice(from);
}

/** A paragraph's words: its text runs joined, tabs, line breaks, and symbols as spaces. */
function paragraphText(p: string): string {
  // An empty run (`<w:t/>`, with or without attributes) is dropped first, so its tag cannot open a match that runs on
  // to the next run's closing tag.
  const parts = p.replace(/<w:t\b[^>]*\/>/g, "").match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:(?:tab|br|cr|sym)\b[^>]*\/>|<w:noBreakHyphen\b[^>]*\/>/g) ?? [];
  return parts
    .map((r) => {
      // A text run (`<w:t>` or `<w:t xml:space=…>`), not a tab, which starts with the same letters.
      if (/^<w:t[\s>]/.test(r)) return unescapeXml(r.replace(/^<w:t(?:\s[^>]*)?>|<\/w:t>$/g, ""));
      if (r.startsWith("<w:noBreakHyphen")) return "-";
      return " ";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** The paragraph styles in `word/styles.xml`, by id. */
function readStyles(xml: string | undefined): Map<string, Style> {
  const styles = new Map<string, Style>();
  for (const s of xml?.match(/<w:style\b[^>]*\bw:type="paragraph"[\s\S]*?<\/w:style>/g) ?? []) {
    const id = /\bw:styleId="([^"]+)"/.exec(s)?.[1];
    if (!id) continue;
    const outline = /<w:outlineLvl\b[^>]*\bw:val="(\d)"/.exec(s)?.[1];
    styles.set(id, {
      name: /<w:name\b[^>]*\bw:val="([^"]+)"/.exec(s)?.[1],
      basedOn: /<w:basedOn\b[^>]*\bw:val="([^"]+)"/.exec(s)?.[1],
      ...(outline !== undefined ? { outline: Number(outline) } : {}),
    });
  }
  return styles;
}

type Kind = "title" | "contents" | number | undefined;

/** What a style name or id means: "title", a heading level, "contents" (a table of contents entry), or nothing. */
function kindOfName(name: string): Kind {
  if (/^title$/i.test(name)) return "title";
  if (/^subtitle$/i.test(name)) return 2;
  if (/^(toc\s?\d|toc\s?heading)$/i.test(name)) return "contents";
  const heading = /^heading\s?(\d)$/i.exec(name);
  return heading ? Number(heading[1]) : undefined;
}

/**
 * "title", a heading level (1 for Heading 1), "contents" for a table of contents line, or undefined for body text.
 * A style is known by its built-in name (Word keeps those in English whatever the language, so a German
 * "Überschrift 1" is still "heading 1") or its outline level, following the styles it is based on.
 */
function kindOf(p: string, styles: Map<string, Style>): Kind {
  // Only the paragraph's own properties count, not its runs'.
  const props = /<w:pPr\b[\s\S]*?<\/w:pPr>/.exec(p)?.[0] ?? "";
  const direct = /<w:outlineLvl\b[^>]*\bw:val="(\d)"/.exec(props)?.[1];
  let id = /<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(props)?.[1];
  for (let hops = 0; id && hops < 10; hops++) {
    const style = styles.get(id);
    const kind = kindOfName(style?.name ?? id);
    if (kind !== undefined) return kind;
    if (style?.outline !== undefined && style.outline < 9) return style.outline + 1;
    id = style?.basedOn;
  }
  return direct !== undefined && Number(direct) < 9 ? Number(direct) + 1 : undefined;
}

/** Paragraphs (`<w:p>…</w:p>`, and the empty `<w:p/>` first, so its tag never opens a match that swallows the next one). */
const PARAGRAPH = String.raw`<w:p\b[^>]*\/>|<w:p(?:\s[^>]*?)?(?<!\/)>[\s\S]*?<\/w:p>`;
/** Paragraphs, and the markers left where tables were. */
const BLOCKS = new RegExp(String.raw`\uE000(\d+)\uE001|` + PARAGRAPH, "g");

/** A table as text: one line per row, its cells joined by commas; a table inside a cell reads as part of that cell. */
function tableText(tbl: string): string {
  const body = inner(tbl);
  return outermost(body, "tr")
    .map(({ start, end }) => {
      const row = inner(body.slice(start, end));
      return outermost(row, "tc")
        .map(({ start: s, end: e }) => cellText(inner(row.slice(s, e))))
        .filter(Boolean)
        .join(", ");
    })
    .filter(Boolean)
    .join("\n");
}

/** A cell's paragraphs joined, with any table inside it read in its place, its rows joined by semicolons. */
function cellText(cell: string): string {
  const parts: string[] = [];
  let from = 0;
  const paragraphs = (xml: string) => (xml.match(new RegExp(PARAGRAPH, "g")) ?? []).map(paragraphText);
  for (const { start, end } of outermost(cell, "tbl")) {
    parts.push(...paragraphs(cell.slice(from, start)), tableText(cell.slice(start, end)).replace(/\n/g, "; "));
    from = end;
  }
  parts.push(...paragraphs(cell.slice(from)));
  return parts.filter(Boolean).join(" ");
}

/**
 * A .docx file's script. Throws a readable error for a file that is not a Word document (a .doc from before 2007,
 * a password-protected file, a renamed one, a broken zip).
 */
export function readDocx(bytes: Uint8Array, name = "The file"): DocxScript {
  // A password-protected document is an encrypted compound file, not a zip, as is a Word 97–2003 .doc.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new Error(`${name} is password-protected or a Word 97–2003 file; remove the password or save it as .docx or plain text`);
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" || f.name === "word/styles.xml" });
  } catch {
    throw new Error(`${name} could not be read as a Word (.docx) file; save it as .docx or plain text`);
  }
  const doc = files["word/document.xml"];
  if (!doc) throw new Error(`${name} is not a Word (.docx) document; save it as .docx or plain text`);
  const styles = readStyles(files["word/styles.xml"] ? strFromU8(files["word/styles.xml"]) : undefined);
  const xml = unwrapContentControls(
    (strFromU8(doc).match(/<w:body\b[\s\S]*<\/w:body>/)?.[0] ?? "")
      // A text box's own paragraphs sit inside a paragraph of the page; its second (fallback) copy is not read twice.
      .replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, "")
      .replace(/<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g, "")
      // Tracked changes, read as the document now stands: a deleted or moved-away range goes (its self-closing
      // markers, which only flag a paragraph mark or a row, first, so they never open a range), and formatting as it
      // was before a change is not this paragraph's.
      .replace(/<w:(?:del|moveFrom)(?=[\s/])[^>]*\/>/g, "")
      .replace(/<w:(del|moveFrom)(?=[\s>])[^>]*>[\s\S]*?<\/w:\1>/g, "")
      .replace(/<w:\w+Change(?=[\s/])[^>]*\/>/g, "")
      .replace(/<w:(\w+Change)(?=[\s>])[^>]*>[\s\S]*?<\/w:\1>/g, "")
      // Hidden text, and the small reading printed above Japanese and Chinese characters, are not read.
      .replace(/<w:r(?:\s[^>]*)?>(?:(?!<\/w:r>)[\s\S])*?<w:vanish\b(?![^>]*\bw:val="(?:0|false|off)")[^>]*\/>[\s\S]*?<\/w:r>/g, "")
      .replace(/<w:rt\b[^>]*>[\s\S]*?<\/w:rt>/g, ""),
  );
  // Tables are set aside (inner tables with them) and read in their place.
  const tables: string[] = [];
  let flat = "";
  let from = 0;
  for (const { start, end } of outermost(xml, "tbl")) {
    flat += `${xml.slice(from, start)}\uE000${tables.push(tableText(xml.slice(start, end))) - 1}\uE001`;
    from = end;
  }
  flat += xml.slice(from);

  const blocks: string[] = [];
  let title: string | undefined;
  for (const m of flat.matchAll(BLOCKS)) {
    if (m[1] !== undefined) {
      if (tables[Number(m[1])]) blocks.push(tables[Number(m[1])]);
      continue;
    }
    const text = paragraphText(m[0]);
    if (!text) continue;
    const kind = kindOf(m[0], styles);
    if (kind === "contents") continue;
    if (kind === undefined) {
      blocks.push(text);
      continue;
    }
    // The title before any text names the video; any other heading starts a new part of the script.
    if (!title && !blocks.some((b) => b !== "---") && (kind === "title" || kind === 1)) {
      title = text.slice(0, 120);
      continue;
    }
    if (blocks.length && blocks[blocks.length - 1] !== "---") blocks.push("---");
  }
  while (blocks[blocks.length - 1] === "---") blocks.pop();
  return { text: blocks.join("\n\n"), ...(title ? { title } : {}) };
}
