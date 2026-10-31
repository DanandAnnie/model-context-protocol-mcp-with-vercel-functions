import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-utils";
import { config } from "@/lib/config";
import { oembedFor, shareLinkTarget, sizeLimit } from "@/lib/oembed";
import { LOCAL_OWNER } from "@/lib/owner";
import { NotFoundError, PUBLIC_ACCESS, getBrandKit, getVideo } from "@/lib/services";

export const dynamic = "force-dynamic";

// Consumers (editors, chat apps, CMSs) may ask from a page of their own, so the answer is readable from any origin.
const HEADERS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const CACHE_SEC = 300;

/**
 * oEmbed for share links: `?url=<share link>&maxwidth=&maxheight=&format=json` → an oEmbed 1.0 `video` answer whose
 * `html` is an iframe of the share page's embed player. A link that is not one of this studio's share pages, or a video
 * whose link is off, expired, in the trash, or missing, is a `404`; `format=xml` is a `501`, as the spec has it.
 */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const format = params.get("format");
    if (format && format !== "json") return NextResponse.json({ error: "Only the json format is offered" }, { status: 501, headers: HEADERS });
    const raw = params.get("url");
    if (!raw) return NextResponse.json({ error: "Give the share link as url" }, { status: 400, headers: HEADERS });
    const base = config.appUrl.replace(/\/$/, "");
    const target = shareLinkTarget(raw, [base, new URL(req.url).origin]);
    if (!target) return NextResponse.json({ error: "Not a share link of this studio" }, { status: 404, headers: HEADERS });
    const video = await getVideo(target.id, PUBLIC_ACCESS, false);
    const brand = await getBrandKit(video.ownerId ?? LOCAL_OWNER);
    const answer = oembedFor(video, {
      base,
      siteName: brand?.name || "Avatar Studio",
      maxWidth: sizeLimit(params.get("maxwidth")),
      maxHeight: sizeLimit(params.get("maxheight")),
      start: target.start,
    });
    // Cached for five minutes at most, and never past the link's expiry, as the email preview is.
    const left = video.shareExpiresAt ? Math.floor((Date.parse(video.shareExpiresAt) - Date.now()) / 1000) : CACHE_SEC;
    const maxAge = Math.max(0, Math.min(CACHE_SEC, left));
    return NextResponse.json(answer, { headers: { ...HEADERS, "Cache-Control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store" } });
  } catch (err) {
    if (err instanceof NotFoundError) return NextResponse.json({ error: "Not found" }, { status: 404, headers: HEADERS });
    const res = errorResponse(err);
    for (const [name, value] of Object.entries(HEADERS)) res.headers.set(name, value);
    return res;
  }
}
