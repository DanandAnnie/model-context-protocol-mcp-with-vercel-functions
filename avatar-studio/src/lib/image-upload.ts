// Pictures picked in the browser, made into data URLs the server accepts. Browser only (FileReader, canvas).

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

/**
 * The picture as a data URL of at most `maxBytes` decoded: a PNG or JPEG that fits as it is, anything else (WebP,
 * GIF, a large photo) redrawn on a canvas as a JPEG no wider or taller than `maxEdge`, shrunk until it fits.
 */
export async function toUploadable(file: File, { maxBytes, maxEdge }: { maxBytes: number; maxEdge: number }): Promise<string> {
  const mb = `${Math.round(maxBytes / (1024 * 1024))} MB`;
  // Decoded first, whatever its name or type says, so a file that only claims to be a picture is refused here.
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file is not an image the browser can read");
  });
  try {
    if ((file.type === "image/png" || file.type === "image/jpeg") && file.size <= maxBytes) return await readAsDataUrl(file);
    let scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 4; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error(`This browser cannot convert the image; upload a PNG or JPEG under ${mb}`);
      // JPEG has no transparency: see-through parts of a PNG or GIF become white, not black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", 0.88);
      // A canvas too large for the browser gives back an empty "data:," instead of an image.
      if (!url.startsWith("data:image/jpeg")) throw new Error("The image is too large for this browser to convert; try a smaller one");
      // Base64 is 4/3 of the bytes.
      if ((url.length - url.indexOf(",") - 1) * 0.75 <= maxBytes) return url;
      scale *= 0.7;
    }
    throw new Error("The image is too large even when shrunk");
  } finally {
    bitmap.close();
  }
}
