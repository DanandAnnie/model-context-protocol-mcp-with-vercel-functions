// Logo image types, shared by the brand page (in the browser) and the logo routes.

/** Image types browsers show in an <img>; the brand kit accepts an uploaded logo only in one of these. */
export const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon"]);

/** The media type of an uploaded (data URL) logo, lower-cased; undefined for an external URL. */
export function logoDataType(logoUrl: string): string | undefined {
  return logoUrl.startsWith("data:") ? logoUrl.slice(5).split(/[;,]/)[0].toLowerCase() : undefined;
}
