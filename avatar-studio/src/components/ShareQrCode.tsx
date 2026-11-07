"use client";
import { useMemo, useState } from "react";
import { Copy, Download } from "lucide-react";
import { safeFileStem } from "@/lib/attachment";
import { type QrSubject, qrDraw, qrMatrix, qrPath, qrSide, qrSvg, qrWording } from "@/lib/qr";

/** The PNG's width and height in pixels: sharp on a printed flyer or a slide. */
const PNG_SIZE = 1024;

/** Saves `blob` as `name` through a temporary link, the way the studio's other downloads do. */
function save(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Some browsers read the file after the click returns, or once a save dialog is answered.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/**
 * A QR code of a share link (or, with `subject` "talk", a presenter's talk link, or with "folder", a shared folder's
 * link), for a flyer, a slide, or a sign at an open house: shown on the page, saved as an SVG (sharp at any size) or a
 * 1024-pixel PNG named after the video, presenter, or folder, or copied as that PNG to paste straight into a slide.
 */
export function ShareQrCode({ url, title, subject = "share" }: { url: string; title: string; subject?: QrSubject }) {
  const wording = qrWording(subject, title);
  const matrix = useMemo(() => qrMatrix(url), [url]);
  const path = useMemo(() => qrPath(matrix), [matrix]);
  const side = qrSide(matrix);
  const stem = `qr-${safeFileStem(title) || (subject === "talk" ? "presenter" : subject === "folder" ? "folder" : "video")}`;
  const [err, setErr] = useState<string | null>(null);
  // The link the last copy was of, so the note does not outlive a change to the link.
  const [copied, setCopied] = useState<string | null>(null);

  /** The code as a PNG of `PNG_SIZE` pixels a side. */
  function png(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = PNG_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("No 2D canvas"));
      qrDraw(ctx, matrix, PNG_SIZE);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("No PNG"))), "image/png");
    });
  }

  function downloadSvg() {
    setErr(null);
    setCopied(null);
    save(new Blob([qrSvg(url, wording.title, matrix)], { type: "image/svg+xml" }), `${stem}.svg`);
  }
  function downloadPng() {
    setErr(null);
    setCopied(null);
    png().then(
      (blob) => save(blob, `${stem}.png`),
      () => setErr("This browser could not make the picture; download the SVG instead."),
    );
  }
  async function copyPng() {
    setErr(null);
    setCopied(null);
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return setErr("This browser cannot copy pictures; use Download PNG instead.");
    // The PNG is encoded inside the write, so a browser that only lets a click copy at once (Safari) still allows it.
    const blob = png();
    blob.catch(() => {});
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setCopied(url);
    } catch {
      // Say which went wrong: the picture, or the browser's clipboard.
      const made = await blob.then(
        () => true,
        () => false,
      );
      setErr(made ? "The browser did not let the page copy the picture; use Download PNG instead." : "This browser could not make the picture; download the SVG instead.");
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-4">
      <svg role="img" aria-label={wording.label} viewBox={`0 0 ${side} ${side}`} className="h-36 w-36 rounded border border-slate-200" shapeRendering="crispEdges" data-testid="share-qr">
        <rect width={side} height={side} fill="#fff" />
        <path d={path} fill="#000" />
      </svg>
      <div className="flex flex-col items-start gap-2">
        <button type="button" onClick={downloadSvg} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50">
          <Download className="h-3.5 w-3.5" /> Download SVG
        </button>
        <button type="button" onClick={downloadPng} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50">
          <Download className="h-3.5 w-3.5" /> Download PNG
        </button>
        <button type="button" onClick={() => void copyPng()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50">
          <Copy className="h-3.5 w-3.5" /> Copy image
        </button>
        <p role="status" className="text-xs text-slate-600 empty:hidden" data-testid="qr-copy-note">
          {copied === url ? "Copied: paste it into a slide, a flyer, or a document." : ""}
        </p>
        {/* Always mounted, so a screen reader announces the first message too. */}
        <p role="alert" className="text-xs text-red-700 empty:hidden">
          {err}
        </p>
      </div>
    </div>
  );
}
