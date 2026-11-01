import { errorResponse, readJson } from "@/lib/api-utils";
import { publicOrigin } from "@/lib/config";
import { toCsv } from "@/lib/csv";
import { requireOwner } from "@/lib/owner";
import { SELECTION_LINK_COLUMNS, selectionLinkRows, selectionLinksSchema, selectionVideos } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The share links of the library's selected videos as a CSV (`{ "ids": [...] }`, up to 200), the link blank until it can be sent. */
export async function POST(req: Request) {
  try {
    const owner = await requireOwner();
    const { ids } = selectionLinksSchema.parse(await readJson(req));
    const videos = await selectionVideos(ids, owner);
    // Ids left out (trashed or deleted since the page loaded, another owner's, unknown), so the page can say so.
    const omitted = new Set(ids).size - videos.length;
    return new Response(toCsv([...SELECTION_LINK_COLUMNS], selectionLinkRows(videos, publicOrigin(req))), {
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
