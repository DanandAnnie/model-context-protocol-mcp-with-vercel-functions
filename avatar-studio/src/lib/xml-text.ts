// Text inside Office XML (PowerPoint and Word files): the escapes XML uses, undone.

/** A numeric character reference's character; one out of Unicode's range is dropped rather than failing the import. */
function codePoint(n: number): string {
  return n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** The characters XML escapes, and numeric references (curly quotes and dashes arrive as those too). */
export function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
