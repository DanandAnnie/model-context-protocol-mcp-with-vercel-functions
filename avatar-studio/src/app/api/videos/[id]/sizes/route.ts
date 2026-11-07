import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { videoSizes } from "@/lib/services";

export const dynamic = "force-dynamic";

/** The video's sizes: the original and the live sizes made from it ("Make other sizes"). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return json({ sizes: await videoSizes(id, await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}
