import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { restoreVideo } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Brings a trashed video back to the library. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return json({ video: await restoreVideo(id, await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}
