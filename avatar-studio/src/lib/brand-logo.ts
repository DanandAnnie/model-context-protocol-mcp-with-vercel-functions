// An uploaded brand logo is a data URL of up to a few megabytes. Public pages link it through a short,
// cacheable route instead of carrying it inline, so it is sent once and cached by the browser.
import { NotFoundError } from "./errors";
import { decodeDataUrl } from "./providers/image";
import { LOGO_TYPES, logoDataUrlValid } from "./logo-types";
import type { BrandKit } from "./types";

/**
 * The address a public page uses for the kit's logo: an external URL as it is, an uploaded one through
 * `route` (versioned by the kit's last save, so a new logo gets a new URL), or undefined without one.
 */
export function publicLogoSrc(brand: Pick<BrandKit, "logoUrl" | "updatedAt"> | null | undefined, route: string): string | undefined {
  if (!brand?.logoUrl) return undefined;
  return brand.logoUrl.startsWith("data:") ? `${route}?v=${encodeURIComponent(brand.updatedAt)}` : brand.logoUrl;
}

/** Whether an uploaded logo decodes to a type the logo route serves: the same check the route makes, so a kit can never save a logo its pages would show broken. */
export function servableLogo(dataUrl: string): boolean {
  if (!logoDataUrlValid(dataUrl)) return false;
  try {
    return LOGO_TYPES.has(decodeDataUrl(dataUrl).mimeType.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The uploaded logo as an image response; 404 when the kit has none or links an external one. A request
 * whose `v` matches the kit's last save may be cached for an hour (never past `expiresAt`, when the page
 * it belongs to expires), so a replaced logo or a link taken offline is not served from caches for long;
 * any other request is not cached at all.
 */
export function logoResponse(brand: Pick<BrandKit, "logoUrl" | "updatedAt"> | null | undefined, req: Request, expiresAt?: string): Response {
  const logoUrl = brand?.logoUrl;
  if (!logoUrl?.startsWith("data:image/")) throw new NotFoundError("Logo not found");
  let logo: { bytes: Uint8Array; mimeType: string };
  try {
    logo = decodeDataUrl(logoUrl);
  } catch {
    throw new NotFoundError("Logo not found");
  }
  const mimeType = logo.mimeType.toLowerCase();
  if (!LOGO_TYPES.has(mimeType)) throw new NotFoundError("Logo not found");
  const current = new URL(req.url).searchParams.get("v") === brand?.updatedAt;
  const untilExpiry = expiresAt ? Math.floor((Date.parse(expiresAt) - Date.now()) / 1000) : Infinity;
  const ttl = Math.max(0, Math.min(3600, untilExpiry));
  return new Response(logo.bytes as BodyInit, {
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(logo.bytes.byteLength),
      "Cache-Control": current && ttl > 0 ? `public, max-age=${ttl}` : "no-store",
      "X-Content-Type-Options": "nosniff",
      // An SVG logo opened on its own runs nothing: no scripts, no requests, no same-origin access.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
