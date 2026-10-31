import { errorResponse } from "@/lib/api-utils";
import { currentUser } from "@/lib/owner";
import { revokeInvite } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; token: string }> }) {
  try {
    const { id, token } = await ctx.params;
    await revokeInvite(id, token, await currentUser());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
