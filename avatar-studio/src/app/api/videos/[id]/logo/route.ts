import { errorResponse } from "@/lib/api-utils";
import { NotFoundError } from "@/lib/errors";
import { LOCAL_OWNER } from "@/lib/owner";
import { decodeDataUrl } from "@/lib/providers/image";
import { PUBLIC_ACCESS, getBrandKit, getVideo } from "@/lib/services";

export const dynamic = "force-dynamic";

const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);

/**
 * The uploaded brand logo shown on a video's share page, so the page links one short, cacheable URL
 * (in the header and the player watermark) instead of carrying the image inline. Public on the share
 * page's own terms: a missing, trashed, or offline video answers 404, and so does a kit whose logo is
 * an external URL (the page links that directly). A password does not hide it, since the locked page
 * shows the brand header too. `?v=` responses are immutable.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const video = await getVideo(id, PUBLIC_ACCESS, false);
    const logoUrl = (await getBrandKit(video.ownerId ?? LOCAL_OWNER))?.logoUrl;
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
  } catch (err) {
    return errorResponse(err);
  }
}
