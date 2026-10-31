import { escapeHtml, posterUrl } from "./client";
import { parseStartTime } from "./share-time";
import { dimensionsFor, type AspectRatio, type Resolution } from "./types";

/** The player's size in an oEmbed answer, as the video page's Embed snippet sizes it, before a consumer's limits. */
const EMBED_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 640, height: 360 },
  "9:16": { width: 360, height: 640 },
  "1:1": { width: 480, height: 480 },
};

/**
 * The embed's size for a frame shape within a consumer's `maxwidth` and `maxheight` (either may be absent): the
 * default size, scaled down as one to fit both, never up, and never below one pixel.
 */
export function embedSize(aspect: AspectRatio, maxWidth?: number, maxHeight?: number): { width: number; height: number } {
  const { width, height } = EMBED_SIZES[aspect] ?? EMBED_SIZES["16:9"];
  const scale = Math.min(1, maxWidth ? maxWidth / width : 1, maxHeight ? maxHeight / height : 1);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** A consumer's `maxwidth` or `maxheight`: a whole number of pixels from 1, or no limit for anything else. */
export function sizeLimit(raw: string | null): number | undefined {
  if (!raw || !/^\d{1,5}$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return n >= 1 ? n : undefined;
}

/**
 * The video a share link names, when it is a link to this studio's share page (`/share/:id`, on one of `origins`), with
 * the time it starts at (`?t=`, as the share page reads it); anything else, another site's or another page's, is null.
 */
export function shareLinkTarget(raw: string, origins: string[]): { id: string; start?: number } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !origins.some((o) => sameOrigin(o, url))) return null;
  const match = /^\/share\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const times = url.searchParams.getAll("t");
  // A time given twice is no time, as on the share page.
  const start = times.length === 1 ? parseStartTime(times[0]) : undefined;
  return { id, ...(start !== undefined ? { start } : {}) };
}

function sameOrigin(origin: string, url: URL): boolean {
  try {
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
}

export interface OembedVideo {
  id: string;
  title: string;
  aspect: AspectRatio;
  resolution?: Resolution;
  cover?: { updatedAt: string; width?: number; height?: number };
  thumbnailUrl?: string;
  shareLocked?: boolean;
}

/**
 * An oEmbed 1.0 answer of type `video` for a shared video: an iframe of the share page's embed player (which still asks
 * for the password or an email first where the owner set one), sized for the frame shape within the consumer's limits,
 * and the cover (else the renderer's frame) as the thumbnail, except behind a password, where the answer carries the
 * title alone as the link preview does. A thumbnail is given only with its size known and within the consumer's limits,
 * as the spec asks.
 */
export function oembedFor(
  video: OembedVideo,
  opts: { base: string; siteName: string; maxWidth?: number; maxHeight?: number; start?: number },
): Record<string, string | number> {
  const { width, height } = embedSize(video.aspect, opts.maxWidth, opts.maxHeight);
  const query = ["embed=1", opts.start !== undefined ? `t=${opts.start}` : ""].filter(Boolean).join("&");
  const src = `${opts.base}/share/${encodeURIComponent(video.id)}?${query}`;
  const html = `<iframe src="${escapeHtml(src)}" width="${width}" height="${height}" style="border:0;max-width:100%" allow="fullscreen; picture-in-picture" allowfullscreen title="${escapeHtml(video.title)}"></iframe>`;
  const answer: Record<string, string | number> = {
    version: "1.0",
    type: "video",
    title: video.title,
    provider_name: opts.siteName,
    provider_url: opts.base,
    html,
    width,
    height,
  };
  const thumbnail = video.shareLocked ? undefined : thumbnailFor(video, opts.base);
  const fits = thumbnail && (!opts.maxWidth || thumbnail.width <= opts.maxWidth) && (!opts.maxHeight || thumbnail.height <= opts.maxHeight);
  if (thumbnail && fits) Object.assign(answer, { thumbnail_url: thumbnail.url, thumbnail_width: thumbnail.width, thumbnail_height: thumbnail.height });
  return answer;
}

/**
 * The picture for a video with its size: a custom cover at the size its header named, else the renderer's frame at the
 * video's own size. A cover kept before its size was read has none, and gives no thumbnail rather than the frame the
 * owner replaced.
 */
function thumbnailFor(video: OembedVideo, base: string): { url: string; width: number; height: number } | undefined {
  if (video.cover) {
    const url = posterUrl(video, base);
    return url && video.cover.width && video.cover.height ? { url, width: video.cover.width, height: video.cover.height } : undefined;
  }
  if (!video.thumbnailUrl) return undefined;
  return { url: video.thumbnailUrl, ...dimensionsFor(video.aspect, video.resolution) };
}
