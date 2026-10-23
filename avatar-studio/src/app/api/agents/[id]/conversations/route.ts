import { errorResponse, json } from "@/lib/api-utils";
import { requireOwner } from "@/lib/owner";
import { clearConversations, listConversations } from "@/lib/services";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Transcripts of visitor conversations with one shared presenter (newest first, up to 50). */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    return json({ conversations: await listConversations((await ctx.params).id, await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    return json({ deleted: await clearConversations((await ctx.params).id, await requireOwner()) });
  } catch (err) {
    return errorResponse(err);
  }
}
