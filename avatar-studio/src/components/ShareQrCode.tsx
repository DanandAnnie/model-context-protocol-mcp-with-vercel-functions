"use client";
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { safeFileStem } from "@/lib/attachment";
import { qrMatrix, qrPath, qrSide, qrSvg } from "@/lib/qr";

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
 * A QR code of a share link, for a flyer, a slide, or a sign at an open house: shown on the page and saved as an SVG
 * (sharp at any size) or a 1024-pixel PNG, named after the video.
 */
export function ShareQrCode({ url, title }: { url: string; title: string }) {
  const matrix = useMemo(() => qrMatrix(url), [url]);
  const path = useMemo(() => qrPath(matrix), [matrix]);
  const side = qrSide(matrix);
  const stem = `qr-${safeFileStem(title) || "video"}`;
  const [err, setErr] = useState<string | null>(null);

  function downloadSvg() {
    setErr(null);
    save(new Blob([qrSvg(url, `Scan to watch “${title}”`, matrix)], { type: "image/svg+xml" }), `${stem}.svg`);
  }
  function downloadPng() {
    setErr(null);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PNG_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return setErr("This browser could not draw the picture; download the SVG instead.");
    // Whole pixels a module, centred, so no module is blurred across two pixels.
    const cell = Math.floor(PNG_SIZE / side);
    const offset = Math.floor((PNG_SIZE - cell * side) / 2);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, PNG_SIZE, PNG_SIZE);
    ctx.fillStyle = "#000";
    const margin = (side - matrix.length) / 2;
    matrix.forEach((row, y) => row.forEach((dark, x) => dark && ctx.fillRect(offset + (x + margin) * cell, offset + (y + margin) * cell, cell, cell)));
    canvas.toBlob((blob) => (blob ? save(blob, `${stem}.png`) : setErr("This browser could not save the picture; download the SVG instead.")), "image/png");
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-4">
      <svg role="img" aria-label="QR code for the share link" viewBox={`0 0 ${side} ${side}`} className="h-36 w-36 rounded border border-slate-200" shapeRendering="crispEdges" data-testid="share-qr">
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
        {/* Always mounted, so a screen reader announces the first message too. */}
        <p role="alert" className="text-xs text-red-700">
          {err}
        </p>
      </div>
    </div>
  );
}
