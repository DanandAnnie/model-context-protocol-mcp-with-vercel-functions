// A document attached to the Video Agent, read to plain text in the browser: a PDF, a Word or PowerPoint file, or
// a text or Markdown file. Only the words (and the file's name) travel to the server, never the file.
import { unzipSync } from "fflate";
import { readDocx } from "./docx-text";
import { pdfText } from "./pdf-slides";
import { readPptx } from "./pptx-notes";
import { decodeScript, legacyEncodingFor } from "./script-import";
import { MAX_DOCUMENT_CHARS } from "./types";

/** A file larger than this is refused before it is read (its pictures count, though only its words are kept). */
export const MAX_DOCUMENT_BYTES = 50_000_000;

/**
 * Text tidied for the planner (runs of blank lines and spaces collapsed) and cut to `max` characters at a word: the
 * cut stays where it falls when a space follows, else goes back to the last space, and never leaves half of a
 * character made of two code units (an emoji).
 */
export function fitDocumentText(text: string, max = MAX_DOCUMENT_CHARS): { text: string; truncated: boolean } {
  const tidy = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (tidy.length <= max) return { text: tidy, truncated: false };
  let cut = tidy.slice(0, max);
  if (!/\s/.test(tidy[max])) {
    const space = cut.search(/\s\S*$/);
    if (space > max / 2) cut = cut.slice(0, space);
  }
  return { text: cut.replace(/[\ud800-\udbff]$/, "").trim(), truncated: true };
}

const startsWith = (b: Uint8Array, ...sig: number[]) => sig.every((v, i) => b[i] === v);
const isZip = (b: Uint8Array) => startsWith(b, 0x50, 0x4b, 0x03, 0x04);
const isCompound = (b: Uint8Array) => startsWith(b, 0xd0, 0xcf, 0x11, 0xe0);
const isPdf = (b: Uint8Array) => startsWith(b, 0x25, 0x50, 0x44, 0x46, 0x2d);

/** Text that is really a binary file read as text: a NUL, or more than one character in fifty a control character. */
function looksBinary(text: string): boolean {
  if (text.includes("\0")) return true;
  const sample = text.slice(0, 4000);
  const controls = sample.match(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f�]/g)?.length ?? 0;
  return sample.length > 0 && controls / sample.length > 0.02;
}

/** A PowerPoint deck's words: each shown slide's text and notes. */
const deckText = (bytes: Uint8Array, name: string) =>
  readPptx(bytes, name)
    .filter((s) => !s.hidden)
    .map((s) => [s.text, s.notes].filter(Boolean).join("\n"))
    .join("\n\n");

/** A Word document's words, its title first; scene breaks mean nothing here, so headings stay paragraph breaks. */
function wordText(bytes: Uint8Array, name: string): string {
  const doc = readDocx(bytes, name);
  return [doc.title, doc.text.replace(/^---$/gm, "")].filter(Boolean).join("\n\n");
}

/**
 * The words of `file`, for the Video Agent to write from. The format is told by the file's first bytes where it can
 * be (a PDF or Office file named or typed otherwise is still read as one). Throws a readable error for a file it
 * cannot read, one that is not text (a picture, a recording), or one with no words in it (a scanned PDF, say).
 */
export async function documentText(file: File, language = "en"): Promise<{ text: string; truncated: boolean }> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error(`${file.name} is larger than ${MAX_DOCUMENT_BYTES / 1_000_000} MB; attach a smaller copy or a PDF of it`);
  if (/^(image|audio|video)\//.test(file.type)) throw new Error(`${file.name} is a picture or recording; attach a PDF, Word, PowerPoint, or text file`);
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const presentation = /\.(pptx|ppsx|ppt|pps)$/i.test(file.name) || /presentationml|ms-powerpoint/.test(file.type);
  let text: string;
  let truncated = false;
  if (isPdf(head) || /\.pdf$/i.test(file.name) || file.type === "application/pdf") {
    // A little more than is kept, so the cut below falls at a word.
    ({ text, truncated } = await pdfText(file, MAX_DOCUMENT_CHARS + 200));
  } else if (isZip(head) || isCompound(head)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isCompound(head)) {
      // An older Office file (or a password-protected one): each reader says how to save its own kind.
      if (presentation) text = deckText(bytes, file.name);
      else if (/\.(xls|xlsx)$/i.test(file.name)) throw new Error(`${file.name} is a spreadsheet; attach a PDF, Word, PowerPoint, or text file`);
      else text = wordText(bytes, file.name);
    } else {
      // A zip is read by what it holds, whatever it is named.
      let parts: string[] = [];
      try {
        parts = Object.keys(unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" || f.name === "ppt/presentation.xml" }));
      } catch {
        // Not a zip after all: refused below.
      }
      if (parts.includes("word/document.xml")) text = wordText(bytes, file.name);
      else if (parts.includes("ppt/presentation.xml")) text = deckText(bytes, file.name);
      else throw new Error(`${file.name} is not a Word or PowerPoint file; attach a PDF, Word, PowerPoint, or text file`);
    }
  } else {
    // Text: only as much as could be kept is decoded (four bytes a character at most), so a huge file costs little.
    const room = (MAX_DOCUMENT_CHARS + 200) * 4;
    // A character the cut splits at the end is one stray byte, which the decoder tolerates; it falls past what is kept.
    const bytes = new Uint8Array(await file.slice(0, room).arrayBuffer());
    text = decodeScript(bytes, legacyEncodingFor(language));
    if (looksBinary(text)) throw new Error(`${file.name} is not a text file; attach a PDF, Word, PowerPoint, or text file`);
    truncated = file.size > room;
  }
  const fitted = fitDocumentText(text);
  if (!fitted.text) throw new Error(`No text found in ${file.name}${isPdf(head) || /\.pdf$/i.test(file.name) ? " (a scanned PDF has pictures of its pages, not words)" : ""}`);
  return { text: fitted.text, truncated: truncated || fitted.truncated };
}
