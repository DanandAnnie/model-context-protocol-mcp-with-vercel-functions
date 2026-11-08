// Logo image types, shared by the brand page (in the browser) and the logo routes.

/** Image types browsers show in an <img>; the brand kit accepts an uploaded logo only in one of these. */
export const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon"]);

/** The media type of an uploaded (data URL) logo, lower-cased; undefined for an external URL. */
export function logoDataType(logoUrl: string): string | undefined {
  return logoUrl.startsWith("data:") ? logoUrl.slice(5).split(/[;,]/)[0].toLowerCase() : undefined;
}

/** File extensions for the types above, for browsers that report no type for some files (AVIF, ICO on Windows). */
const LOGO_EXTENSIONS: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon" };

/** The logo type of a picked file: its reported type, or one read from its extension when the browser reports none. */
export function logoFileType(file: { type: string; name: string }): string | undefined {
  const type = file.type.toLowerCase() || LOGO_EXTENSIONS[file.name.split(".").pop()?.toLowerCase() ?? ""];
  return type && LOGO_TYPES.has(type) ? type : undefined;
}

/**
 * Whether an uploaded logo (a data URL) is one the logo route can serve: a comma, an allowed type in any
 * case, and a payload that decodes. Runs in the browser and on the server, so the brand page and the
 * kit's check never disagree.
 */
export function logoDataUrlValid(dataUrl: string): boolean {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) return false;
  if (!LOGO_TYPES.has(logoDataType(dataUrl) ?? "")) return false;
  let payload: string;
  try {
    // Percent-escapes are undone first, as browsers do, so "%2B" counts as "+".
    payload = decodeURIComponent(dataUrl.slice(comma + 1));
  } catch {
    return false;
  }
  // Base64 in either alphabet: standard (+/) or URL-safe (-_).
  if (/;base64$/i.test(dataUrl.slice(0, comma))) return /^[A-Za-z0-9+/_-]+={0,2}$/.test(payload.replace(/\s+/g, ""));
  return payload.length > 0;
}
