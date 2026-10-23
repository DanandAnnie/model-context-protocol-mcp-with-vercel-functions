// Fetch a portrait as bytes for provider uploads. Accepts data: URLs and public http(s) URLs.
import { safeFetch, type FetchLike } from "../safe-fetch";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function loadImage(url: string, fetchImpl?: FetchLike): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (url.startsWith("data:")) return decodeDataUrl(url);
  const res = await safeFetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) }, "Image URL", fetchImpl);
  if (!res.ok) throw new Error(`Could not download avatar image (${res.status})`);
  const mimeType = res.headers.get("content-type")?.split(";")[0].trim() ?? "image/jpeg";
  if (!mimeType.startsWith("image/")) throw new Error("Avatar URL did not return an image");
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error("Avatar image is too large (10 MB max)");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("Avatar image is too large (10 MB max)");
  return { bytes: new Uint8Array(buf), mimeType };
}

/** Handles both base64 and utf8/percent-encoded payloads (the app's own stock portraits use the latter). */
export function decodeDataUrl(url: string): { bytes: Uint8Array; mimeType: string } {
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("Malformed data URL");
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const mimeType = meta.split(";")[0] || "application/octet-stream";
  const bytes = /;base64/i.test(meta) ? new Uint8Array(Buffer.from(payload, "base64")) : new TextEncoder().encode(decodeURIComponent(payload));
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Avatar image is too large (10 MB max)");
  return { bytes, mimeType };
}
