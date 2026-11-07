import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { getStudioTemplate } from "@/lib/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** One template's variables, with their current defaults, and its scenes' scripts. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireOwner();
    const { id } = await ctx.params;
    return json({ template: await getStudioTemplate(id) });
  } catch (err) {
    return errorResponse(err);
  }
}
