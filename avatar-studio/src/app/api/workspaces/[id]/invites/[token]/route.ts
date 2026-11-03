import { errorResponse, json } from "@/lib/api-utils";
import { deliverInvite } from "@/lib/invite-mail";
import { currentUser } from "@/lib/owner";
import { renewInvite, revokeInvite } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/**
 * Resends a pending invite: the same link gets a fresh 7-day expiry and, when the invite names an
 * address and email is configured, the email goes out again. Answers as creating an invite does.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; token: string }> }) {
  try {
    const user = await currentUser();
    const { id, token } = await ctx.params;
    const invite = await renewInvite(id, token, user);
    return json({ invite, ...(await deliverInvite(req, invite, user)) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; token: string }> }) {
  try {
    const { id, token } = await ctx.params;
    await revokeInvite(id, token, await currentUser());
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
