// Turning a slide deck saved as PDF into scenes, like HeyGen's PDF import: each page becomes a picture (uploaded
// as a background image by the editor) and its text a first draft of what the presenter says. The rendering runs in
// the browser with pdf.js, loaded only when a deck is imported; the text handling is plain and runs anywhere.
import { MAX_SCRIPT_CHARS } from "./script-import";
import { MAX_SCENES } from "./types";

/** A rendered page: a JPEG data URL, its text, and its shape. */
export interface SlidePage {
  image: string;
  text: string;
  width: number;
  height: number;
}

/** Text items as pdf.js gives them: a run of characters and whether a line ends after it. */
interface TextRun {
  str?: string;
  hasEOL?: boolean;
}

/** A page's text read in order, one line per line of the page, with runs of spaces collapsed. */
export function pageText(runs: TextRun[]): string {
  let out = "";
  for (const run of runs) {
    if (typeof run.str !== "string") continue;
    out += run.str;
    out += run.hasEOL ? "\n" : "";
  }
  return out
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * The scripts for a deck's pages: each page's lines joined into sentences, ending in a full stop where a line has
 * no closing punctuation (a slide title or bullet), and the whole kept within a video's script budget by giving each
 * page an equal share, cut at a word. `truncated` is true when anything was cut.
 */
export function slideScripts(texts: string[], budget = MAX_SCRIPT_CHARS): { scripts: string[]; truncated: boolean } {
  const spoken = texts.map((t) =>
    t
      .split("\n")
      .map((line) => line.replace(/^[-•▪●◦*–]\s*/, "").trim())
      .filter(Boolean)
      .map((line) => (/[.!?:;…]$/.test(line) ? line : `${line}.`))
      .join(" "),
  );
  const total = spoken.reduce((n, s) => n + s.length, 0);
  if (total <= budget) return { scripts: spoken, truncated: false };
  // Room left by short pages goes to the long ones.
  const scripts = [...spoken];
  let left = budget;
  let open = scripts.map((_, i) => i).sort((a, b) => scripts[a].length - scripts[b].length);
  while (open.length) {
    const share = Math.floor(left / open.length);
    const fits = open.filter((i) => scripts[i].length <= share);
    if (!fits.length) {
      for (const i of open) scripts[i] = cutAtWord(scripts[i], share);
      break;
    }
    for (const i of fits) left -= scripts[i].length;
    open = open.filter((i) => !fits.includes(i));
  }
  return { scripts, truncated: true };
}

function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trim()}…`;
}

/** The longest edge a page is drawn at: a 1080p frame's width. */
const PAGE_EDGE = 1920;
/** What one background image may weigh on the server. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * Renders up to `MAX_SCENES` pages of a PDF in the browser. `total` is the deck's page count, so the caller can say
 * when pages were left out. Throws a readable error for a file pdf.js cannot open (not a PDF, password-protected).
 */
export async function renderPdf(file: File, onPage?: (done: number, of: number) => void): Promise<{ pages: SlidePage[]; total: number }> {
  // The legacy build: the modern one calls very new JavaScript (Map.prototype.getOrInsertComputed, for one) that
  // current Chrome and Safari releases do not all have yet; the legacy build carries polyfills for it.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy();
    const name = (err as { name?: string }).name;
    throw new Error(name === "PasswordException" ? `${file.name} is password-protected; save a copy without the password` : `${file.name} could not be read as a PDF`);
  }
  try {
    const count = Math.min(doc.numPages, MAX_SCENES);
    const pages: SlidePage[] = [];
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PAGE_EDGE / Math.max(base.width, base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This browser cannot draw the slides");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      let image = canvas.toDataURL("image/jpeg", 0.85);
      if ((image.length - image.indexOf(",") - 1) * 0.75 > MAX_IMAGE_BYTES) image = canvas.toDataURL("image/jpeg", 0.6);
      const text = pageText((await page.getTextContent()).items as TextRun[]);
      pages.push({ image, text, width: canvas.width, height: canvas.height });
      page.cleanup();
      onPage?.(n, count);
    }
    return { pages, total: doc.numPages };
  } finally {
    await task.destroy();
  }
}
