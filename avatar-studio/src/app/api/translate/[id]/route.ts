import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { getTranslation } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return json({ translation: await getTranslation(id, await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}
