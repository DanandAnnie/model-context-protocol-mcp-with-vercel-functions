"use client";
import { useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { ErrorBanner } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/client";
import { backdropIdOf, backdropPath, type Backdrop, type Background } from "@/lib/types";

/** What the server takes (3 MB decoded); larger pictures, and other formats, are redrawn as a JPEG first. */
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
/** The longest edge kept when a picture is redrawn: enough for a 4K frame. */
const MAX_EDGE = 3840;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

/**
 * The picture as a data URL the server accepts: a PNG or JPEG under the size cap as it is, anything else (WebP,
 * GIF, a large photo) redrawn on a canvas as a JPEG, shrunk until it fits.
 */
async function toUploadable(file: File): Promise<string> {
  if ((file.type === "image/png" || file.type === "image/jpeg") && file.size <= MAX_UPLOAD_BYTES) return readAsDataUrl(file);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file is not an image the browser can read");
  });
  let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 4; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.88);
    // Base64 is 4/3 of the bytes.
    if ((url.length - url.indexOf(",") - 1) * 0.75 <= MAX_UPLOAD_BYTES) return url;
    scale *= 0.7;
  }
  throw new Error("The image is too large even when shrunk");
}

/**
 * The scene's uploaded background images: upload one from the computer, pick one, or delete one. A deleted image
 * is taken off every scene that used it (`onDeleted`), since a render that names it would be refused.
 */
export function BackdropPicker({ value, onChange, onDeleted, canEdit }: { value: Background; onChange: (bg: Background) => void; onDeleted: (id: string) => void; canEdit: boolean }) {
  const { data, error, setData } = useApi<{ backdrops: Backdrop[] }>("/api/backdrops");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const selected = backdropIdOf(value);
  const backdrops = data?.backdrops ?? [];

  async function upload(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const image = await toUploadable(file);
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Background";
      const { backdrop } = await api<{ backdrop: Backdrop }>("/api/backdrops", { method: "POST", body: JSON.stringify({ name, image }) });
      setData((d) => ({ backdrops: [backdrop, ...(d?.backdrops ?? [])] }));
      onChange({ type: "image", value: backdropPath(backdrop.id) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not upload the image");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(b: Backdrop) {
    if (!window.confirm(`Delete "${b.name}"? Scenes using it go back to a plain background; videos already rendered keep it.`)) return;
    setErr(null);
    try {
      await api(`/api/backdrops/${b.id}`, { method: "DELETE" });
      setData((d) => ({ backdrops: (d?.backdrops ?? []).filter((x) => x.id !== b.id) }));
      onDeleted(b.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not delete the image");
    }
  }

  return (
    <div data-testid="backdrops">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-slate-700">Your images</div>
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={!canEdit || busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
        >
          <ImagePlus className="h-3.5 w-3.5" /> {busy ? "Uploading…" : "Upload image"}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="Background image file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
      <ErrorBanner message={error ?? err} />
      {backdrops.length === 0 ? (
        <p className="text-xs text-slate-500">Upload a PNG, JPEG, or WebP picture (a slide, a photo of the office, a product shot) to show it behind the avatar. Large pictures are shrunk to fit.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {backdrops.map((b) => (
            <div key={b.id} className="group relative">
              <button
                type="button"
                onClick={() => onChange({ type: "image", value: backdropPath(b.id) })}
                aria-label={`Use ${b.name}`}
                aria-pressed={selected === b.id}
                title={b.name}
                className={`block aspect-video w-full overflow-hidden rounded-lg border bg-slate-100 ${selected === b.id ? "border-brand-500 ring-2 ring-brand-500" : "border-slate-200"}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- served by the app with the owner's session, not by the image optimiser */}
                <img src={backdropPath(b.id)} alt="" className="h-full w-full object-cover" loading="lazy" />
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => remove(b)}
                  aria-label={`Delete ${b.name}`}
                  className="absolute right-1 top-1 rounded-full bg-white/90 p-1 text-slate-600 shadow hover:text-rose-600"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
