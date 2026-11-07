import { errorResponse, json, readJson } from "@/lib/api-utils";
import { deliverInvite, inviteAllowance } from "@/lib/invite-mail";
import { currentUser } from "@/lib/owner";
import { recordActivity } from "@/lib/services";
import { bulkInviteSchema, createInvite, createInvites, inviteSchema } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

const SEND_AT_ONCE = 5;

/**
 * Creates an invite and returns the link to share. When an email address is given and an email
 * provider is configured, the invite is also sent; `emailed` reports whether that happened. With
 * `emails` (up to MAX_BULK_INVITES) instead of `email`, it invites each address with its own link.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (body && typeof body === "object" && "emails" in body) {
      // Several addresses: one invite each; skipped ones are reported, not refused. Each can send an
      // email, so the batch draws on an hourly allowance per workspace, taken whole or not at all.
      const { invites, skipped } = await createInvites(id, bulkInviteSchema.parse(body), user, inviteAllowance(id));
      // One line for the batch, before the emails go: the address when it was one invite, else how many.
      if (invites.length === 1) await recordActivity(id, user, "invite.sent", { subject: invites[0].email, role: invites[0].role });
      else if (invites.length > 1) await recordActivity(id, user, "invite.sent", { count: invites.length, role: invites[0].role });
      const sent = [];
      // A few sends at a time, so twenty slow ones do not run one after another into the time limit.
      for (let i = 0; i < invites.length; i += SEND_AT_ONCE) {
        const chunk = invites.slice(i, i + SEND_AT_ONCE);
        sent.push(...(await Promise.all(chunk.map(async (invite) => ({ invite, ...(await deliverInvite(req, invite, user)) })))));
      }
      return json({ invites: sent, skipped }, { status: 201 });
    }
    const invite = await createInvite(id, inviteSchema.parse(body), user, inviteAllowance(id));
    await recordActivity(id, user, "invite.sent", { subject: invite.email, role: invite.role });
    return json({ invite, ...(await deliverInvite(req, invite, user)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
