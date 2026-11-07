import { errorResponse, json } from "@/lib/api-utils";
import { recordRequestActivity } from "@/lib/activity-request";
import { requireEditor } from "@/lib/owner";
import { duplicateAgent } from "@/lib/services";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** A copy of the presenter under a new link, which starts off (see `duplicateAgent`). */
export async function POST(_req: Request, ctx: Ctx) {
  try {
    const owner = await requireEditor();
    const agent = await duplicateAgent((await ctx.params).id, owner);
    await recordRequestActivity(owner, "agent.duplicated", { subject: agent.name, subjectId: agent.id });
    return json({ agent }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
