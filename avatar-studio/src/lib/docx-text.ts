// Reading a Word document (.docx) as a script, like HeyGen's script upload: its paragraphs in order, a heading
// starting a new scene, and the first title (before any text) offered as the video's title. Only the document's
// XML is unpacked (never its pictures), and it runs the same in the browser and in tests.
import { strFromU8, unzipSync } from "fflate";
import { unescapeXml } from "./xml-text";

export interface DocxScript {
  /** Plain text: paragraphs separated by a blank line, and a `---` line where a heading starts a new part. */
  text: string;
  /** The document's title: a Title (or first top-level heading) paragraph before any other text. */
  title?: string;
}

/** A paragraph's words: its text runs joined, tabs and line breaks as spaces; deleted text and field codes are not read. */
function paragraphText(p: string): string {
  // An empty run (`<w:t/>`, with or without attributes) is dropped first, so its tag cannot open a match that runs on
  // to the next run's closing tag.
  const parts = p.replace(/<w:t\b[^>]*\/>/g, "").match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:(?:tab|br|cr)\b[^>]*\/>|<w:noBreakHyphen\b[^>]*\/>/g) ?? [];
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

/**
 * Paragraphs (`<w:p>…</w:p>`, and the empty `<w:p/>` first, so its tag never opens a match that swallows the next
 * paragraph), and with `tables`, whole tables.
 */
const PARAGRAPH = String.raw`<w:p\b[^>]*\/>|<w:p(?:\s[^>]*?)?(?<!\/)>[\s\S]*?<\/w:p>`;
const PARAGRAPHS = new RegExp(PARAGRAPH, "g");
const BLOCKS = new RegExp(String.raw`<w:tbl\b[\s\S]*?<\/w:tbl>|` + PARAGRAPH, "g");

/** "Title", or the level of a heading style or outline level (1 for Heading 1); undefined for body text. */
function headingOf(p: string): "title" | number | undefined {
  const style = /<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(p)?.[1] ?? "";
  if (/^(title|subtitle)$/i.test(style)) return /^title$/i.test(style) ? "title" : 2;
  const named = /^heading\s?(\d)$/i.exec(style);
  if (named) return Number(named[1]);
  const outline = /<w:outlineLvl\b[^>]*\bw:val="(\d)"/.exec(p)?.[1];
  return outline !== undefined && Number(outline) < 9 ? Number(outline) + 1 : undefined;
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
    files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  } catch {
    throw new Error(`${name} could not be read as a Word (.docx) file; save it as .docx or plain text`);
  }
  const doc = files["word/document.xml"];
  if (!doc) throw new Error(`${name} is not a Word (.docx) document; save it as .docx or plain text`);
  const body =
    strFromU8(doc)
      // A text box's own paragraphs sit inside a paragraph of the page; its second (fallback) copy is not read twice.
      .replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, "")
      .replace(/<w:txbxContent\b[\s\S]*?<\/w:txbxContent>/g, "")
      // Tracked deletions are not part of the document as it reads now.
      .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")
      .match(/<w:body\b[\s\S]*<\/w:body>/)?.[0] ?? "";
  const blocks: string[] = [];
  let title: string | undefined;
  // A table reads one row per line, its cells joined by commas, as one paragraph.
  for (const block of body.match(BLOCKS) ?? []) {
    if (block.startsWith("<w:tbl")) {
      const rows = (block.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [])
        .map((tr) => (tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map((tc) => (tc.match(PARAGRAPHS) ?? []).map(paragraphText).filter(Boolean).join(" ")).filter(Boolean).join(", "))
        .filter(Boolean);
      if (rows.length) blocks.push(rows.join("\n"));
      continue;
    }
    const text = paragraphText(block);
    if (!text) continue;
    const heading = headingOf(block);
    if (heading === undefined) {
      blocks.push(text);
      continue;
    }
    // The title before any text names the video; any other heading starts a new part of the script.
    if (!title && !blocks.some((b) => b !== "---") && (heading === "title" || heading === 1)) {
      title = text.slice(0, 120);
      continue;
    }
    if (blocks.length && blocks[blocks.length - 1] !== "---") blocks.push("---");
  }
  while (blocks[blocks.length - 1] === "---") blocks.pop();
  return { text: blocks.join("\n\n"), ...(title ? { title } : {}) };
}
