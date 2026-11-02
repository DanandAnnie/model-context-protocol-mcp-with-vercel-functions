// QR codes for share links, for a flyer, a slide, or a sign. Pure, so the video page and the tests share it.
import qrcode from "qrcode-generator";
import { safeFileStem } from "./attachment";

/** The quiet zone a reader needs around the code, in modules (the QR standard's four). */
export const QR_MARGIN = 4;

/**
 * The code's modules (true for dark), row by row, for `text` at error correction level M (about 15% of the code can
 * be lost to a fold or a smudge and it still scans), at the smallest version that holds it. The text is encoded as
 * UTF-8 bytes, which is what phone cameras read; the library itself would keep only the low byte of each character.
 */
export function qrMatrix(text: string): boolean[][] {
  const code = qrcode(0, "M");
  const utf8 = Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join("");
  code.addData(utf8, "Byte");
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => code.isDark(row, col)));
}

/** One path drawing every dark module as a unit square, offset by the quiet zone, for a `viewBox` of `qrSide`. */
export function qrPath(matrix: boolean[][], margin = QR_MARGIN): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    // A run of dark modules in a row is one rectangle, which keeps the path (and the file) small.
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < row.length && row[end + 1]) end++;
      parts.push(`M${x + margin} ${y + margin}h${end - x + 1}v1h-${end - x + 1}z`);
      x = end;
    }
  });
  return parts.join("");
}

/** The width (and height) of the code with its quiet zone, in modules. */
export function qrSide(matrix: boolean[][], margin = QR_MARGIN): number {
  return matrix.length + margin * 2;
}

/** Characters an XML file may not hold at all (control characters, U+FFFE and U+FFFF, half a surrogate pair). */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A standalone SVG file of the code (from `qrMatrix(text)`, or `matrix` when it is already made): black on a white
 * ground, sharp at any size, with `title` kept to what an XML file may hold.
 */
export function qrSvg(text: string, title = "QR code", matrix = qrMatrix(text)): string {
  const side = qrSide(matrix);
  const escaped = title.replace(NOT_XML, "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side * 8}" height="${side * 8}" shape-rendering="crispEdges"><title>${escaped}</title><rect width="${side}" height="${side}" fill="#fff"/><path d="${qrPath(matrix)}" fill="#000"/></svg>\n`;
}

/**
 * Draws the code with its quiet zone, black on white, filling a `size`-pixel square (at least `qrSide(matrix)`
 * pixels): whole pixels a module, centred, so no module is blurred across two pixels when the picture is printed.
 */
export function qrDraw(ctx: Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect">, matrix: boolean[][], size: number): void {
  const side = qrSide(matrix);
  const cell = Math.floor(size / side);
  const offset = Math.floor((size - cell * side) / 2) + QR_MARGIN * cell;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  matrix.forEach((row, y) => row.forEach((dark, x) => dark && ctx.fillRect(offset + x * cell, offset + y * cell, cell, cell)));
}

/** What a code links to: a video's share page, or an interactive presenter's talk page. */
export type QrSubject = "share" | "talk";

/** How a code is named on the page (`label`) and inside its SVG file (`title`), for a video or presenter `name`. */
export function qrWording(subject: QrSubject, name: string): { label: string; title: string } {
  return subject === "talk" ? { label: "QR code for the talk link", title: `Scan to talk to “${name}”` } : { label: "QR code for the share link", title: `Scan to watch “${name}”` };
}

/** The most UTF-8 bytes a name's title part takes, so the whole name stays under the 255 bytes macOS and Linux allow. */
const QR_NAME_BYTES = 200;

/** `stem` cut to `QR_NAME_BYTES` of UTF-8 at a character a person sees as one, without loose dots or spaces at its end. */
function byteFit(stem: string): string {
  const bytes = new TextEncoder();
  if (bytes.encode(stem).length <= QR_NAME_BYTES) return stem;
  let out = "";
  let used = 0;
  for (const { segment } of new Intl.Segmenter().segment(stem)) {
    used += bytes.encode(segment).length;
    if (used > QR_NAME_BYTES) break;
    out += segment;
  }
  return out.replace(/[\s.]+$/u, "");
}

/**
 * File names for a set of codes saved together, one per title in order: `qr-<title>.svg` (`qr-video.svg` for a title
 * with nothing left to name a file by, and a title cut to fit the 255 bytes a name may take), with " (2)", " (3)"… on a
 * name already taken, compared as a file system that ignores case would, so no file in a zip overwrites another once
 * unpacked.
 */
export function qrFileNames(titles: string[], ext = "svg"): string[] {
  return uniqueFileNames(titles, ext, "qr-");
}

/**
 * A file name for each title (`<prefix><title>.<ext>`, "video" for a title with nothing a file name can keep), cut to fit
 * what a file system allows, with " (2)" and so on on a name another already has, ignoring case, so none overwrites another
 * once a zip of them is unpacked.
 */
export function uniqueFileNames(titles: string[], ext: string, prefix = ""): string[] {
  const taken = new Set<string>();
  return titles.map((title) => {
    const stem = `${prefix}${byteFit(safeFileStem(title)) || "video"}`;
    let name = `${stem}.${ext}`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n}).${ext}`;
    taken.add(name.toLowerCase());
    return name;
  });
}
