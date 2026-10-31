// Picture sizes read from their headers, kept with a video's cover for its oEmbed thumbnail.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imageSize } from "../image-size";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("imageSize", () => {
  it("reads a PNG's IHDR", () => {
    const png = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR", [0, 0, 0x04, 0x38, 0, 0, 0x07, 0x80], [8, 6, 0, 0, 0]);
    assert.deepEqual(imageSize(png, "image/png"), { width: 1080, height: 1920 });
    const onePixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    assert.deepEqual(imageSize(new Uint8Array(onePixel), "image/png"), { width: 1, height: 1 });
  });

  it("reads a GIF's logical screen", () => {
    assert.deepEqual(imageSize(bytes("GIF89a", [0x80, 0x02, 0xe0, 0x01]), "image/gif"), { width: 640, height: 480 });
  });

  it("finds a JPEG's frame past the segments before it", () => {
    const jpeg = bytes([0xff, 0xd8], [0xff, 0xe0, 0, 16], "JFIF", [0, 1, 1, 0, 0, 1, 0, 1, 0, 0], [0xff, 0xff], [0xff, 0xc2, 0, 17, 8, 0x02, 0xd0, 0x05, 0x00, 3]);
    assert.deepEqual(imageSize(jpeg, "image/jpeg"), { width: 1280, height: 720 });
    // A huffman table (0xC4) shares the range but names no size.
    const withTable = bytes([0xff, 0xd8], [0xff, 0xc4, 0, 4, 0, 0], [0xff, 0xc0, 0, 17, 8, 0, 100, 0, 200, 3]);
    assert.deepEqual(imageSize(withTable, "image/jpeg"), { width: 200, height: 100 });
  });

  it("reads each kind of WebP", () => {
    const head = (chunk: string) => bytes("RIFF", [0, 0, 0, 0], "WEBP", chunk, [0, 0, 0, 0]);
    const lossy = new Uint8Array([...head("VP8 "), 0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]);
    assert.deepEqual(imageSize(lossy, "image/webp"), { width: 640, height: 480 });
    // 640×480 in VP8L's packing: width-1 in 14 bits, then height-1 in 14 bits.
    const w = 639, h = 479;
    const packed = w | (h << 14);
    const lossless = new Uint8Array([...head("VP8L"), 0x2f, packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff, (packed >> 24) & 0xff, 0, 0, 0, 0]);
    assert.deepEqual(imageSize(lossless, "image/webp"), { width: 640, height: 480 });
    const extended = new Uint8Array([...head("VP8X"), 0, 0, 0, 0, 0x7f, 0x07, 0x00, 0x37, 0x04, 0x00]);
    assert.deepEqual(imageSize(extended, "image/webp"), { width: 1920, height: 1080 });
  });

  it("names no size for another kind or a header that does not parse", () => {
    assert.equal(imageSize(bytes("GIF89a", [0, 0, 0, 0]), "image/gif"), undefined, "a zero size");
    const huge = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR", [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 1], [8, 6, 0, 0, 0]);
    assert.equal(imageSize(huge, "image/png"), undefined, "a side no picture has");
    assert.equal(imageSize(bytes("not a png at all, really"), "image/png"), undefined);
    assert.equal(imageSize(bytes([0xff, 0xd8, 0x00, 0x00]), "image/jpeg"), undefined);
    assert.equal(imageSize(bytes([0xff, 0xd8, 0xff, 0xc0, 0, 17]), "image/jpeg"), undefined, "cut short");
    assert.equal(imageSize(bytes("RIFF0000WEBPVP8?"), "image/webp"), undefined);
    assert.equal(imageSize(bytes("GIF89a", [1, 0, 1, 0]), "image/svg+xml"), undefined);
  });
});
