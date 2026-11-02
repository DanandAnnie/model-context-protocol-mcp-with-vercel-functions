import { strToU8, zipSync } from "fflate";
import { errorResponse, readJson } from "@/lib/api-utils";
import { publicOrigin } from "@/lib/config";
import { toCsv } from "@/lib/csv";
import { ConflictError } from "@/lib/errors";
import { requireOwner } from "@/lib/owner";
import { SELECTION_LINK_COLUMNS, selectionLinkRows, selectionLinkText, selectionLinksSchema, selectionQrFiles, selectionVideos } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * The share links of the library's selected videos as a CSV (`{ "ids": [...] }`, up to 200), the link blank until it can
 * be sent; with `?format=text`, only the links that can be sent, one a line, for the clipboard; with `?format=qr`, a zip
 * of a QR code (SVG) for each link that can be sent, for printing, refused when there is none.
 */
export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    const { ids } = selectionLinksSchema.parse(await readJson(req));
    const videos = await selectionVideos(ids, owner);
    // Ids left out (trashed or deleted since the page loaded, another owner's, unknown), so the page can say so.
    const omitted = new Set(ids).size - videos.length;
    const rows = selectionLinkRows(videos, publicOrigin(req));
    const format = new URL(req.url).searchParams.get("format");
    if (format === "qr") {
      const { files, links, unsendable } = selectionQrFiles(rows);
      if (!links) throw new ConflictError("None of the selected videos has a link that can be sent yet (still rendering, failed, switched off, expired, or not live until later); Download links says why for each.");
      const zip = zipSync(Object.fromEntries(files.map((f) => [f.name, strToU8(f.svg)])));
      return new Response(zip, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="qr-codes-${new Date().toISOString().slice(0, 10)}.zip"`,
          "Cache-Control": "no-store",
          "X-Links": String(links),
          "X-Omitted": String(omitted),
          "X-Unsendable": String(unsendable),
        },
      });
    }
    if (format === "text") {
      const { text, links, unsendable } = selectionLinkText(rows);
      return new Response(text, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Links": String(links), "X-Omitted": String(omitted), "X-Unsendable": String(unsendable) },
      });
    }
    return new Response(toCsv([...SELECTION_LINK_COLUMNS], rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="links-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
        "X-Omitted": String(omitted),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
