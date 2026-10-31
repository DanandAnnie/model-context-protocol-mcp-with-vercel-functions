import { errorResponse, json } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { listVideoLeads, videoLeadsCsv } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The emails a video's share-page gate collected, newest first; `?format=csv` downloads them. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    // Viewer emails are personal data: workspace viewers watch and comment, they do not get the list.
    const owner = await requireEditor();
    const { id } = await ctx.params;
    const leads = await listVideoLeads(id, owner);
    if (new URL(req.url).searchParams.get("format") === "csv") {
      return new Response(videoLeadsCsv(leads), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="viewer-emails-${id}.csv"`, "Cache-Control": "no-store" },
      });
    }
    return json({ leads });
  } catch (err) {
    return errorResponse(err);
  }
}
