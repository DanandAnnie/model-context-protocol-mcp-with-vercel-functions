// Fetch a portrait as bytes for provider uploads. Accepts data: URLs and https URLs.
export async function loadImage(url: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (url.startsWith("data:")) {
    const [meta, b64] = url.split(",");
    const mimeType = /data:([^;]+)/.exec(meta)?.[1] ?? "image/png";
    return { bytes: new Uint8Array(Buffer.from(b64, "base64")), mimeType };
  }
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not download avatar image (${res.status})`);
  const mimeType = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
  return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType };
}
