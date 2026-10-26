// Turning a slide deck saved as PDF into scenes, like HeyGen's PDF import: each page becomes a picture (uploaded
// as a background image by the editor) and its text a first draft of what the presenter says. The rendering runs in
// the browser with pdf.js, loaded only when a deck is imported; the text handling is plain and runs anywhere.
import { PAUSE_MARKER } from "./pauses";
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

/** A line that already ends a sentence: closing punctuation, maybe followed by a closing quote or bracket. */
const ENDED = /[.!?:;…][\s"'”’»)\]]*$/;
/** A line ending in a pause marker (or made of one): a full stop after it would be read as a word. */
const ENDS_IN_PAUSE = new RegExp(`${PAUSE_MARKER}\\s*$`, "i");

/**
 * The scripts for a deck's pages: each page's lines joined into sentences, ending in a full stop where a line has
 * no closing punctuation (a slide title or bullet), and the whole kept within a video's script budget by giving each
 * page an equal share, cut at a word. The budget counts the blank line the editor and the server put between scenes.
 * `truncated` is true when anything was cut.
 */
export function slideScripts(texts: string[], budget = MAX_SCRIPT_CHARS): { scripts: string[]; truncated: boolean } {
  const spoken = texts.map((t) =>
    t
      .split("\n")
      .map((line) => line.replace(/^[-•▪●◦*–]\s*/, "").trim())
      .filter(Boolean)
      .map((line) => (ENDED.test(line) || ENDS_IN_PAUSE.test(line) ? line : `${line}.`))
      .join(" "),
  );
  const total = spoken.reduce((n, s) => n + s.length, 0);
  const room = Math.max(0, budget - SCENE_SEPARATOR.length * Math.max(0, spoken.length - 1));
  if (total <= room) return { scripts: spoken, truncated: false };
  // Room left by short pages goes to the long ones.
  const scripts = [...spoken];
  let left = room;
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

/** How scenes are joined into the video's script, which the 5000-character limit applies to. */
const SCENE_SEPARATOR = "\n\n";

function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "";
  const cut = text.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trim()}…`;
}

/** The frames a deck is drawn into, by the first page's shape: the video's format at 1080p. */
export const SLIDE_FRAMES = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
} as const;
export type SlideAspect = keyof typeof SLIDE_FRAMES;

/** The format for a page of this shape: wide pages (16:9 and 4:3 alike) landscape, tall ones portrait. */
export function slideAspect(width: number, height: number): SlideAspect {
  const ratio = width / height;
  return ratio > 1.2 ? "16:9" : ratio < 0.83 ? "9:16" : "1:1";
}

/** What one background image may weigh on the server. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** How long pdf.js may take to open a deck before the import gives up (a worker that never loads would never answer). */
const OPEN_TIMEOUT_MS = 60_000;

/** The worker's address, emitted by the bundler next to the app's other static files. */
const WORKER_URL = () => new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

/** The canvas as a JPEG data URL under the server's size cap, lowering the quality until it fits. */
function encode(canvas: HTMLCanvasElement): string {
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (!url.startsWith("data:image/jpeg")) throw new Error("This browser could not encode the slide; try a smaller PDF");
    if ((url.length - url.indexOf(",") - 1) * 0.75 <= MAX_IMAGE_BYTES) return url;
  }
  throw new Error("A slide is too detailed to fit in 3 MB even at low quality");
}

/**
 * A PDF opened with pdf.js in the browser (the worker loaded on first use). Throws a readable error for a file pdf.js
 * cannot open (not a PDF, password-protected) or a worker that fails to load. The caller destroys the task.
 */
async function openPdf(file: File) {
  // The legacy build: the modern one calls very new JavaScript (Map.prototype.getOrInsertComputed, for one) that
  // current Chrome and Safari releases do not all have yet; the legacy build carries polyfills for it.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js starts the worker itself from this address and reports one that fails to load.
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc: Awaited<typeof task.promise>;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutException" })), OPEN_TIMEOUT_MS);
    });
    doc = await Promise.race([task.promise, timeout]).finally(() => clearTimeout(timer));
  } catch (err) {
    await task.destroy().catch(() => undefined);
    const name = (err as { name?: string }).name;
    if (name === "PasswordException") throw new Error(`${file.name} is password-protected; save a copy without the password`);
    if (name === "TimeoutException") throw new Error("The PDF reader did not start; reload the page and try again");
    throw new Error(`${file.name} could not be read as a PDF`);
  }
  return { doc, task };
}

/**
 * A PDF's text, page by page (as on a slide deck's pages), until `maxChars` are read; `truncated` when pages were
 * left. Nothing is drawn, so even a long document reads quickly.
 */
export async function pdfText(file: File, maxChars: number): Promise<{ text: string; truncated: boolean }> {
  const { doc, task } = await openPdf(file);
  try {
    const pages: string[] = [];
    let length = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      if (length >= maxChars) return { text: pages.join("\n\n"), truncated: true };
      const page = await doc.getPage(n);
      const text = pageText((await page.getTextContent()).items as TextRun[]);
      page.cleanup();
      if (text) {
        pages.push(text);
        length += text.length + 2;
      }
    }
    return { text: pages.join("\n\n"), truncated: false };
  } finally {
    await task.destroy();
  }
}

/**
 * Draws up to `MAX_SCENES` pages of a PDF in the browser, one at a time, each centred in the frame of the format the
 * first page's shape calls for (so a 4:3 slide is letterboxed in white rather than cropped by the stage), and hands
 * each to `onPage` (which uploads it) before drawing the next, so only one page's picture is held at a time.
 * `onStart` hears how many pages will be drawn before any is, and may throw to stop (for instance when the account
 * has no room for that many images). Throws a readable error for a file pdf.js cannot open (not a PDF,
 * password-protected) or a worker that fails to load.
 */
export async function renderPdf(
  file: File,
  handlers: {
    onStart?: (info: { count: number; total: number; aspect: SlideAspect }) => void | Promise<void>;
    onPage: (page: SlidePage, index: number, count: number) => Promise<void>;
  },
): Promise<{ count: number; total: number; aspect: SlideAspect }> {
  const { doc, task } = await openPdf(file);
  try {
    const count = Math.min(doc.numPages, MAX_SCENES);
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    const aspect = slideAspect(first.width, first.height);
    const frame = SLIDE_FRAMES[aspect];
    await handlers.onStart?.({ count, total: doc.numPages, aspect });
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot draw the slides");
    try {
      for (let n = 1; n <= count; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(frame.width / base.width, frame.height / base.height);
        const viewport = page.getViewport({ scale });
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, frame.width, frame.height);
        // Centred: the page's own transform is offset by the bars on either side.
        const offset: [number, number, number, number, number, number] = [1, 0, 0, 1, (frame.width - viewport.width) / 2, (frame.height - viewport.height) / 2];
        await page.render({ canvas, viewport, transform: offset }).promise;
        const text = pageText((await page.getTextContent()).items as TextRun[]);
        const image = encode(canvas);
        page.cleanup();
        await handlers.onPage({ image, text, width: frame.width, height: frame.height }, n - 1, count);
      }
    } finally {
      // Hand the bitmap back at once instead of waiting for garbage collection (iOS caps canvas memory).
      canvas.width = 0;
      canvas.height = 0;
    }
    return { count, total: doc.numPages, aspect };
  } finally {
    await task.destroy();
  }
}
