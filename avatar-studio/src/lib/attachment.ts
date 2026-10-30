/** File extensions for the media types a clip or picture is stored as. */
const EXTENSIONS: Record<string, string[]> = {
  "audio/wav": ["wav", "wave"],
  "audio/mpeg": ["mp3"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
};

/** Longest saved name, in characters as a person sees them, before the extension. */
const MAX_NAME = 80;

/** Half of a UTF-16 pair with no other half: valid in a JSON string, but `encodeURIComponent` throws on it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Control and invisible formatting characters (a right-to-left override can disguise a name), path separators,
 * quotes, and the characters Windows refuses in a file name never belong in a saved file's name. The joiners that
 * hold an emoji or a script's letters together stay.
 */
const UNSAFE = /(?:[\p{Cc}/\\"<>:|?*]|(?![\u200C\u200D])\p{Cf})+/gu;

/** Dots and spaces at either end: a leading dot hides a file, and Windows drops trailing ones. */
const LOOSE_ENDS = /^[.\s]+|[.\s]+$/g;

/**
 * A `Content-Disposition` that saves a stored file under the name it was given: `name` as typed (any script, up to
 * 80 characters) in `filename*`, and an ASCII fallback in `filename` for clients that do not read it. The extension
 * follows `mimeType`, never the name, and is not doubled when the name already ends in it ("intro.wav" stays
 * "intro.wav").
 */
export function attachmentDisposition(name: string, mimeType: string, fallback = "download"): string {
  const exts = EXTENSIONS[mimeType] ?? [];
  const ext = exts[0] ? `.${exts[0]}` : "";
  let stem = name.replace(LONE_SURROGATE, "").normalize("NFC").replace(UNSAFE, " ").replace(/\s+/g, " ").replace(LOOSE_ENDS, "");
  const dot = stem.lastIndexOf(".");
  if (dot > 0 && exts.includes(stem.slice(dot + 1).toLowerCase())) stem = stem.slice(0, dot).replace(LOOSE_ENDS, "");
  // Cut by what a person sees as one character, so an emoji sequence or an accented letter is never split.
  const graphemes = Array.from(new Intl.Segmenter().segment(stem), (s) => s.segment);
  if (graphemes.length > MAX_NAME) stem = graphemes.slice(0, MAX_NAME).join("").replace(LOOSE_ENDS, "");
  const ascii =
    stem
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 60)
      .replace(/^[._-]+|[._-]+$/g, "") || fallback;
  const utf8 = encodeURIComponent((stem || fallback) + ext).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}${ext}"; filename*=UTF-8''${utf8}`;
}
