// A custom cover (poster) image for a video, kept in its own record so library responses stay
// light: the video only carries `cover.updatedAt`, and the bytes are served by /api/videos/:id/cover.
import { decodeDataUrl } from "./providers/image";
import { ValidationError } from "./errors";
import { nowIso } from "./ids";
import { getStore } from "./store";
import type { Video } from "./types";

export type Cover = { id: string; videoId: string; ownerId?: string; mimeType: string; data: string; updatedAt: string };

export const MAX_COVER_BYTES = 2 * 1024 * 1024;
const COVER_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Prefixed like every other per-video record: the Supabase table keys every kind by id alone. */
export const coverId = (videoId: string) => `cover_${videoId}`;

export async function setCover(video: Pick<Video, "id" | "ownerId">, dataUrl: string): Promise<Cover> {
  if (!dataUrl.startsWith("data:image/")) throw new ValidationError("The cover must be an uploaded image");
  const { bytes, mimeType } = decodeDataUrl(dataUrl);
  if (!COVER_TYPES.has(mimeType)) throw new ValidationError("The cover must be a PNG, JPEG, WebP, or GIF image");
  if (bytes.byteLength > MAX_COVER_BYTES) throw new ValidationError("The cover image is too large (2 MB max)");
  const cover: Cover = { id: coverId(video.id), videoId: video.id, ownerId: video.ownerId, mimeType, data: Buffer.from(bytes).toString("base64"), updatedAt: nowIso() };
  return getStore().put("cover", cover);
}

export function clearCover(videoId: string): Promise<void> {
  return getStore().remove("cover", coverId(videoId));
}

export async function getCover(videoId: string): Promise<{ mimeType: string; bytes: Uint8Array; updatedAt: string } | null> {
  const cover = await getStore().get<Cover>("cover", coverId(videoId));
  return cover ? { mimeType: cover.mimeType, bytes: new Uint8Array(Buffer.from(cover.data, "base64")), updatedAt: cover.updatedAt } : null;
}
