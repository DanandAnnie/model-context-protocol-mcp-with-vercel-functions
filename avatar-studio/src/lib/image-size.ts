/**
 * The pixel size a PNG, JPEG, WebP, or GIF says it has, read from its header; undefined for another kind or a header
 * that does not parse. Nothing is decoded: only the few bytes that name the size are read.
 */
export function imageSize(bytes: Uint8Array, mimeType: string): { width: number; height: number } | undefined {
  const size = (() => {
    switch (mimeType) {
      case "image/png":
        return pngSize(bytes);
      case "image/gif":
        return gifSize(bytes);
      case "image/jpeg":
        return jpegSize(bytes);
      case "image/webp":
        return webpSize(bytes);
    }
  })();
  return size && size.width > 0 && size.height > 0 && size.width <= MAX_SIDE && size.height <= MAX_SIDE ? size : undefined;
}

/** The longest side taken at its word: JPEG and WebP cannot name more, and a larger PNG header is not a picture to trust. */
const MAX_SIDE = 65535;

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function pngSize(b: Uint8Array) {
  if (b.length < 24 || ascii(b, 1, 3) !== "PNG" || ascii(b, 12, 4) !== "IHDR") return undefined;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gifSize(b: Uint8Array) {
  if (b.length < 10 || ascii(b, 0, 4) !== "GIF8") return undefined;
  return { width: le16(b, 6), height: le16(b, 8) };
}

function jpegSize(b: Uint8Array) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1];
    // Fill bytes before a marker, and markers that carry no length.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = be16(b, i + 2);
    if (length < 2) return undefined;
    // A start of frame (any but the huffman, arithmetic, and extension markers that share the range) names the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return undefined;
      return { width: be16(b, i + 7), height: be16(b, i + 5) };
    }
    i += 2 + length;
  }
  return undefined;
}

function webpSize(b: Uint8Array) {
  if (b.length < 25 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return undefined;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") return b.length < 30 ? undefined : { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return undefined;
    return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
  }
  if (chunk === "VP8X") return b.length < 30 ? undefined : { width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  return undefined;
}
