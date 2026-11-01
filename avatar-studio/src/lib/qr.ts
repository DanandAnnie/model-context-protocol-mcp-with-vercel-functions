// QR codes for share links, for a flyer, a slide, or a sign. Pure, so the video page and the tests share it.
import qrcode from "qrcode-generator";

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
