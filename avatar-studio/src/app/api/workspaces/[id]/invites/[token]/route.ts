import { z } from "zod";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { deliverInvite } from "@/lib/invite-mail";
import { currentUser } from "@/lib/owner";
import { roleSchema } from "@/lib/roles";
import { recordActivity } from "@/lib/services";
import { renewInvite, revokeInvite, setInviteRole } from "@/lib/workspaces";

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
    // Recorded before the email goes, so a send that fails still leaves the renewal in the feed.
    await recordActivity(id, user, "invite.resent", { subject: invite.email, role: invite.role });
    return json({ invite, ...(await deliverInvite(req, invite, user)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Changes the role a pending invite will grant ({ role }); its link, address, and expiry stay. No email is sent. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; token: string }> }) {
  try {
    const user = await currentUser();
    const { id, token } = await ctx.params;
    const { role } = z.object({ role: roleSchema }).parse(await readJson(req));
    const { invite, changed } = await setInviteRole(id, token, role, user);
    if (changed) await recordActivity(id, user, "invite.role", { subject: invite.email, role: invite.role });
    return json({ invite: { token: invite.token, email: invite.email, role: invite.role, expiresAt: invite.expiresAt } });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; token: string }> }) {
  try {
    const user = await currentUser();
    const { id, token } = await ctx.params;
    const removed = await revokeInvite(id, token, user);
    // Dismissing an invite that had already expired takes nothing away from anyone: no line in the feed.
    if (removed && Date.parse(removed.expiresAt) > Date.now()) await recordActivity(id, user, "invite.revoked", { subject: removed.email, role: removed.role });
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
