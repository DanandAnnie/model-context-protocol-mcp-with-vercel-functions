// A document attached to the Video Agent, read to plain text in the browser: a PDF, a Word or PowerPoint file, or
// a text or Markdown file. Only the words travel to the server, never the file.
import { readDocx } from "./docx-text";
import { pdfText } from "./pdf-slides";
import { readPptx } from "./pptx-notes";
import { decodeScript, legacyEncodingFor } from "./script-import";
import { MAX_DOCUMENT_CHARS } from "./types";

/** A file larger than this is refused before it is read (its pictures count, though only its words are kept). */
export const MAX_DOCUMENT_BYTES = 50_000_000;

/** Text tidied for the planner (runs of blank lines and spaces collapsed) and cut at a word to `max` characters. */
export function fitDocumentText(text: string, max = MAX_DOCUMENT_CHARS): { text: string; truncated: boolean } {
  const tidy = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (tidy.length <= max) return { text: tidy, truncated: false };
  const cut = tidy.slice(0, max);
  const space = cut.search(/\s\S*$/);
  return { text: (space > max / 2 ? cut.slice(0, space) : cut).trim(), truncated: true };
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/**
 * The words of `file`, for the Video Agent to write from. Throws a readable error for a file it cannot read, or one
 * with no words in it (a scanned PDF, say).
 */
export async function documentText(file: File, language = "en"): Promise<{ text: string; truncated: boolean }> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error(`${file.name} is larger than ${MAX_DOCUMENT_BYTES / 1_000_000} MB; attach a smaller copy or a PDF of it`);
  let text: string;
  let truncated = false;
  if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
    // A little more than is kept, so the cut below falls at a word.
    ({ text, truncated } = await pdfText(file, MAX_DOCUMENT_CHARS + 200));
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.pptx$/i.test(file.name)) {
      text = readPptx(bytes, file.name).filter((s) => !s.hidden).map((s) => [s.text, s.notes].filter(Boolean).join("\n")).join("\n\n");
    } else if (/\.docx$/i.test(file.name) || isZip(bytes) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
      const doc = readDocx(bytes, file.name);
      // Scene breaks mean nothing here: the headings' places are kept as paragraph breaks.
      text = [doc.title, doc.text.replace(/^---$/gm, "")].filter(Boolean).join("\n\n");
    } else {
      text = decodeScript(bytes, legacyEncodingFor(language));
    }
  }
  const fitted = fitDocumentText(text);
  if (!fitted.text) throw new Error(`No text found in ${file.name}${/\.pdf$/i.test(file.name) ? " (a scanned PDF has pictures of its pages, not words)" : ""}`);
  return { text: fitted.text, truncated: truncated || fitted.truncated };
}
