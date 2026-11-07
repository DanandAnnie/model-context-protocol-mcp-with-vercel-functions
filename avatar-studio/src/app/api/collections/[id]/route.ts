import { errorResponse } from "@/lib/api-utils";
import { requireEditor } from "@/lib/owner";
import { stopSharingFolder } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Stops sharing a folder: its link answers "not found" from then on; the videos and their own links are untouched. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const owner = await requireEditor();
    const { id } = await ctx.params;
    await stopSharingFolder(id, owner);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
