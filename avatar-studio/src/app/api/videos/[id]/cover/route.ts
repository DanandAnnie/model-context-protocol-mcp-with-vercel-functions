import { cookies } from "next/headers";
import { errorResponse } from "@/lib/api-utils";
import { shareOffline } from "@/lib/client";
import { getCover } from "@/lib/cover";
import { NotFoundError } from "@/lib/errors";
import { LOCAL_OWNER, optionalOwner } from "@/lib/owner";
import { shareCookieName, shareUnlocked } from "@/lib/share-lock";
import { getStore } from "@/lib/store";
import type { Video } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The video's custom cover image. Public under the share page's rules: an offline link answers
 * 404, a password-protected one needs the unlock cookie (or the owner), and a link with no
 * cover answers 404. Requests carrying `?v=` are immutable, so a replaced cover gets a new URL;
 * only a freely shared video's cover is marked cacheable by shared caches.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const video = await getStore().get<Video>("video", id);
    if (!video || !video.cover) throw new NotFoundError("Cover not found");
    const owner = await optionalOwner();
    const isOwner = !!owner && (video.ownerId ?? LOCAL_OWNER) === owner;
    if (!isOwner) {
      if (shareOffline(video)) throw new NotFoundError("Cover not found");
      if (!(await shareUnlocked(video, (await cookies()).get(shareCookieName(id))?.value))) throw new NotFoundError("Cover not found");
    }
    const cover = await getCover(id);
    if (!cover) throw new NotFoundError("Cover not found");
    const versioned = new URL(req.url).searchParams.has("v");
    // A cover anyone may fetch can sit in shared caches (CDN); one behind a password or an offline
    // link is served per viewer, so only that viewer's browser may keep it.
    const shared = !video.shareLocked && !shareOffline(video);
    const cacheControl = !versioned ? "no-store" : shared ? "public, max-age=31536000, immutable" : "private, max-age=31536000, immutable";
    return new Response(cover.bytes as BodyInit, {
      headers: {
        "Content-Type": cover.mimeType,
        "Content-Length": String(cover.bytes.byteLength),
        "Cache-Control": cacheControl,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
