// An uploaded brand logo is a data URL of up to a few megabytes. Public pages link it through a short,
// cacheable route instead of carrying it inline, so it is sent once and cached by the browser.
import { NotFoundError } from "./errors";
import { decodeDataUrl } from "./providers/image";
import type { BrandKit } from "./types";

const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);

/**
 * The address a public page uses for the kit's logo: an external URL as it is, an uploaded one through
 * `route` (versioned by the kit's last save, so a new logo gets a new URL), or undefined without one.
 */
export function publicLogoSrc(brand: Pick<BrandKit, "logoUrl" | "updatedAt"> | null | undefined, route: string): string | undefined {
  if (!brand?.logoUrl) return undefined;
  return brand.logoUrl.startsWith("data:") ? `${route}?v=${encodeURIComponent(brand.updatedAt)}` : brand.logoUrl;
}

/** The uploaded logo as an image response; 404 when the kit has none or links an external one. `?v=` responses are immutable. */
export function logoResponse(logoUrl: string | undefined, req: Request): Response {
  if (!logoUrl?.startsWith("data:image/")) throw new NotFoundError("Logo not found");
  let logo: { bytes: Uint8Array; mimeType: string };
  try {
    logo = decodeDataUrl(logoUrl);
  } catch {
    throw new NotFoundError("Logo not found");
  }
  if (!LOGO_TYPES.has(logo.mimeType)) throw new NotFoundError("Logo not found");
  const versioned = new URL(req.url).searchParams.has("v");
  return new Response(logo.bytes as BodyInit, {
    headers: {
      "Content-Type": logo.mimeType,
      "Content-Length": String(logo.bytes.byteLength),
      "Cache-Control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      // An SVG logo opened on its own runs nothing: no scripts, no requests, no same-origin access.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
