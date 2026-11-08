import { errorResponse } from "@/lib/api-utils";
import { logoResponse } from "@/lib/brand-logo";
import { NotFoundError } from "@/lib/errors";
import { getBrandKit } from "@/lib/services";
import { getStore } from "@/lib/store";
import type { Agent } from "@/lib/types";

export const dynamic = "force-dynamic";

/** The uploaded brand logo on a shared presenter's talk page; 404 once the link is paused or removed, as for the page. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const agent = await getStore().get<Agent>("agent", (await ctx.params).id);
    if (!agent || !agent.isPublic) throw new NotFoundError("Logo not found");
    return logoResponse(await getBrandKit(agent.ownerId), req);
  } catch (err) {
    return errorResponse(err);
  }
}
