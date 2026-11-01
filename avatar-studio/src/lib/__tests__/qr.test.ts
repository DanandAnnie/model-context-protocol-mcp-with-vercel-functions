// QR codes for share links: the modules a reader needs (finder patterns, timing, quiet zone), an SVG that draws exactly
// them, and text kept as UTF-8. Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jsQR from "jsqr";
import { QR_MARGIN, qrDraw, qrMatrix, qrPath, qrSide, qrSvg, qrWording } from "../qr";

const url = "https://studio.example.com/share/vid_mf3k2abcd1234efgh";

/** What a camera would read from the code, drawn 4 pixels a module with its quiet zone. */
function scan(matrix: boolean[][], scale = 4): string | undefined {
  const side = qrSide(matrix) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + QR_MARGIN) * scale + dy) * side + (x + QR_MARGIN) * scale + dx) * 4;
          pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
        }
    }),
  );
  const found = jsQR(pixels, side, side);
  return found ? new TextDecoder().decode(new Uint8Array(found.binaryData)) : undefined;
}

/** The dark modules a path draws, read back from its rectangles. */
function drawn(path: string, margin = QR_MARGIN): Set<string> {
  const cells = new Set<string>();
  for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    const [x, y, w] = [Number(m[1]) - margin, Number(m[2]) - margin, Number(m[3])];
    for (let i = 0; i < w; i++) cells.add(`${x + i},${y}`);
  }
  return cells;
}

describe("qrMatrix", () => {
  it("is square, of a QR version's size, and the same for the same text", () => {
    const m = qrMatrix(url);
    assert.ok(m.length >= 21 && (m.length - 17) % 4 === 0, `size ${m.length} is 17 + 4 × version`);
    assert.ok(m.every((row) => row.length === m.length));
    assert.deepEqual(qrMatrix(url), m);
    assert.notDeepEqual(qrMatrix(`${url}x`), m);
  });

  it("has the three finder patterns in its corners and the timing pattern between them", () => {
    const m = qrMatrix(url);
    const n = m.length;
    const finder = (r0: number, c0: number) => {
      for (let r = 0; r < 7; r++)
        for (let c = 0; c < 7; c++) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          assert.equal(m[r0 + r][c0 + c], ring || core, `finder at ${r0},${c0} module ${r},${c}`);
        }
    };
    finder(0, 0);
    finder(0, n - 7);
    finder(n - 7, 0);
    for (let i = 8; i < n - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0, `timing row at ${i}`);
      assert.equal(m[i][6], i % 2 === 0, `timing column at ${i}`);
    }
  });

  it("scans back to the text it was made from, beyond Latin-1 too", () => {
    for (const text of [url, "https://例え.jp/share/vid_ā", "https://studio.example.com/share/" + "x".repeat(300)]) {
      assert.equal(scan(qrMatrix(text)), text);
    }
    // Kept to one byte a character, "ā" (U+0101) would be the same code as "\u0001".
    assert.notDeepEqual(qrMatrix("ā"), qrMatrix("\u0001"));
  });
});

describe("qrSvg", () => {
  it("draws exactly the dark modules, inside a four-module quiet zone", () => {
    const m = qrMatrix(url);
    const path = qrPath(m);
    // Nothing in the path but unit-high runs, so it draws no module the matrix does not have.
    assert.equal(path.replace(/M\d+ \d+h(\d+)v1h-\1z/g, ""), "");
    const cells = drawn(path);
    const dark = new Set<string>();
    m.forEach((row, y) => row.forEach((on, x) => on && dark.add(`${x},${y}`)));
    assert.deepEqual(cells, dark);
    assert.equal(qrSide(m), m.length + 2 * QR_MARGIN);
  });

  it("is a standalone file with a white ground and an escaped title", () => {
    const svg = qrSvg(url, `Scan for "Tour" & <more>`);
    const side = qrSide(qrMatrix(url));
    assert.match(svg, new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"`));
    assert.match(svg, /<rect width="\d+" height="\d+" fill="#fff"\/>/);
    assert.match(svg, /<title>Scan for &quot;Tour&quot; &amp; &lt;more&gt;<\/title>/);
    // Characters no XML file may hold are left out of the title, so the file still opens.
    assert.match(qrSvg(url, "Bell\u0007 \u001b[1mTour\uFFFF \uD800end"), /<title>Bell \[1mTour end<\/title>/);
    assert.equal(qrSvg(url, "t", qrMatrix(url)), qrSvg(url, "t"));
    assert.ok(svg.endsWith("</svg>\n"));
  });
});

describe("qrDraw", () => {
  /** Paints what `qrDraw` asks for into a `size`-pixel grey bitmap (0 black, 255 white, 128 never painted). */
  function paint(matrix: boolean[][], size: number) {
    const px = new Uint8ClampedArray(size * size).fill(128);
    const ctx = {
      fillStyle: "" as string | CanvasGradient | CanvasPattern,
      fillRect(x: number, y: number, w: number, h: number) {
        assert.ok(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(w) && Number.isInteger(h), "whole pixels only");
        assert.ok(x >= 0 && y >= 0 && x + w <= size && y + h <= size, "inside the picture");
        for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px[j * size + i] = this.fillStyle === "#000" ? 0 : 255;
      },
    };
    qrDraw(ctx, matrix, size);
    return px;
  }

  /** Checks each module (and the quiet zone) is one solid square of whole pixels in its place, then scans the picture. */
  function check(matrix: boolean[][], size: number, text: string) {
    const px = paint(matrix, size);
    const side = qrSide(matrix);
    const cell = Math.floor(size / side);
    const offset = Math.floor((size - cell * side) / 2);
    assert.ok(cell >= 1);
    for (let y = -QR_MARGIN; y < matrix.length + QR_MARGIN; y++)
      for (let x = -QR_MARGIN; x < matrix.length + QR_MARGIN; x++) {
        const dark = matrix[y]?.[x] === true;
        const top = offset + (y + QR_MARGIN) * cell;
        const left = offset + (x + QR_MARGIN) * cell;
        for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) assert.equal(px[(top + dy) * size + left + dx], dark ? 0 : 255, `module ${x},${y}`);
      }
    // Outside the code, the border left by whole-pixel cells is white too.
    assert.equal(px[0], 255);
    assert.equal(px[size * size - 1], 255);
    assert.ok(!px.includes(128));
    const rgba = new Uint8ClampedArray(size * size * 4);
    px.forEach((v, i) => rgba.set([v, v, v, 255], i * 4));
    assert.equal(jsQR(rgba, size, size)?.data, text);
  }

  it("fills the picture with whole-pixel modules, centred in a white ground, that scan back to the link", () => {
    check(qrMatrix(url), 1024, url);
  });

  it("fits a long link's larger code at a size that leaves a border, still at whole pixels", () => {
    const long = `${url}?t=${"9".repeat(600)}`;
    const m = qrMatrix(long);
    assert.ok(256 % qrSide(m) !== 0 && Math.floor(256 / qrSide(m)) >= 2);
    check(m, 256, long);
  });
});

describe("qrWording", () => {
  it("names a video's code by its share link and a presenter's by its talk link", () => {
    assert.deepEqual(qrWording("share", "Open house"), { label: "QR code for the share link", title: "Scan to watch “Open house”" });
    assert.deepEqual(qrWording("talk", "Ask Dana"), { label: "QR code for the talk link", title: "Scan to talk to “Ask Dana”" });
  });

  it("gives a title qrSvg keeps to what an SVG file may hold", () => {
    const { title } = qrWording("talk", `Ask <Dana> & "Sam"\u0007`);
    assert.match(qrSvg(url, title), /<title>Scan to talk to “Ask &lt;Dana&gt; &amp; &quot;Sam&quot;”<\/title>/);
  });
});
