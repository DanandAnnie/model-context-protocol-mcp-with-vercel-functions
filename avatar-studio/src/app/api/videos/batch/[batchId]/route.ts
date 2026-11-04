import { strToU8, zipSync } from "fflate";
import { errorResponse } from "@/lib/api-utils";
import { BATCH_NOTHING_TO_SEND } from "@/lib/client";
import { publicOrigin } from "@/lib/config";
import { toCsv } from "@/lib/csv";
import { ConflictError } from "@/lib/errors";
import { requireOwner } from "@/lib/owner";
import { BATCH_LINK_COLUMNS, batchLinkRows, batchVideos, selectionLinkText, selectionQrFiles } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * One personalized batch's videos as a CSV for a mail merge: row, recipient, status, and the share link once it can be
 * sent. With `?format=text`, only the links that can be sent now, one a line in the CSV's order, for the clipboard; the
 * `X-Links` and `X-Unsendable` headers count the lines and the recipients left out. With `?format=qr`, a zip of a QR
 * code (SVG) for each of those links, named after the videos, for printing; refused when there is none.
 */
export async function GET(req: Request, ctx: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = await ctx.params;
    const videos = await batchVideos(batchId, await requireOwner());
    const rows = batchLinkRows(videos, publicOrigin(req));
    const format = new URL(req.url).searchParams.get("format");
    const safeId = batchId.replace(/[^a-z0-9_-]/gi, "");
    if (format === "qr") {
      const { files, links, unsendable } = selectionQrFiles(rows);
      if (!links) throw new ConflictError(BATCH_NOTHING_TO_SEND);
      return new Response(zipSync(Object.fromEntries(files.map((f) => [f.name, strToU8(f.svg)]))), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="qr-codes-${safeId}.zip"`,
          "Cache-Control": "no-store",
          "X-Links": String(links),
          "X-Unsendable": String(unsendable),
        },
      });
    }
    if (format === "text") {
      const { text, links, unsendable } = selectionLinkText(rows);
      return new Response(text, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Links": String(links), "X-Unsendable": String(unsendable) },
      });
    }
    return new Response(toCsv([...BATCH_LINK_COLUMNS], rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="links-${safeId}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
