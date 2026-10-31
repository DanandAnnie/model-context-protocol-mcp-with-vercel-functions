"use client";
import { useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { ErrorBanner } from "@/components/ui";
import { api } from "@/lib/client";
import { toUploadable } from "@/lib/image-upload";
import { backdropIdOf, backdropPath, type Backdrop, type Background } from "@/lib/types";

/** What the server takes (3 MB decoded); larger pictures, and other formats, are redrawn as a JPEG first. */
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
/** The longest edge kept when a picture is redrawn: enough for a 4K frame. */
const MAX_EDGE = 3840;

/**
 * The scene's uploaded background images: upload one from the computer, pick one, or delete one. The editor owns
 * the list (`backdrops`, `setBackdrops`), so it can take an image that is gone off every scene that names it.
 */
export function BackdropPicker({
  value,
  onChange,
  backdrops,
  setBackdrops,
  loadError,
  canEdit,
}: {
  value: Background;
  onChange: (bg: Background) => void;
  backdrops: Backdrop[];
  setBackdrops: (update: (list: Backdrop[]) => Backdrop[]) => void;
  loadError: string | null;
  canEdit: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const selected = backdropIdOf(value);

  async function upload(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const image = await toUploadable(file, { maxBytes: MAX_UPLOAD_BYTES, maxEdge: MAX_EDGE });
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Background";
      const { backdrop } = await api<{ backdrop: Backdrop }>("/api/backdrops", { method: "POST", body: JSON.stringify({ name, image }) });
      setBackdrops((list) => [backdrop, ...list]);
      onChange({ type: "image", value: backdropPath(backdrop.id) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not upload the image");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(b: Backdrop) {
    if (!window.confirm(`Delete "${b.name}"? Scenes, templates, and the brand kit using it go back to a plain background; videos already rendered keep it.`)) return;
    setErr(null);
    try {
      await api(`/api/backdrops/${b.id}`, { method: "DELETE" });
      setBackdrops((list) => list.filter((x) => x.id !== b.id));
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
          accept="image/png,image/jpeg,image/webp,image/gif"
          aria-label="Background image file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
      <ErrorBanner message={loadError ?? err} />
      {backdrops.length === 0 ? (
        <p className="text-xs text-slate-500">Upload a PNG, JPEG, WebP, or GIF picture (a slide, a photo of the office, a product shot) to show it behind the avatar. Large pictures are shrunk to fit.</p>
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
                  className="absolute right-1 top-1 rounded-full bg-white/90 p-1.5 text-slate-600 shadow hover:text-rose-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
