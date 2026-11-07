import { errorResponse, json } from "@/lib/api-utils";
import { deliverInvite, inviteAllowance } from "@/lib/invite-mail";
import { currentUser } from "@/lib/owner";
import { recordActivity } from "@/lib/services";
import { reinviteExpired } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/**
 * Invites an expired invite's address again: a new link with the same role and a full 7 days,
 * emailed when it names an address and email is configured. Answers as creating an invite does.
 * Draws on the same hourly invite allowance per workspace as a batch of invites.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; token: string }> }) {
  try {
    const user = await currentUser();
    const { id, token } = await ctx.params;
    const invite = await reinviteExpired(id, token, user, inviteAllowance(id));
    await recordActivity(id, user, "invite.sent", { subject: invite.email, role: invite.role });
    return json({ invite, ...(await deliverInvite(req, invite, user)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
