// The link and email for a workspace invite, shared by creating an invite and resending one.
import { config } from "./config";
import { getEmailProvider, inviteEmail } from "./providers/email";
import { reserveRateLimit } from "./rate-limit";
import type { WorkspaceInvite } from "./types";
import { getWorkspace, type User } from "./workspaces";

export interface InviteDelivery {
  url: string;
  /** True when the invite had an address and the email provider accepted the message. */
  emailed: boolean;
  /** The provider's error when sending failed; the link still works and can be shared by hand. */
  emailError?: string;
}

/** Builds the join link on the request's origin and, when the invite names an address and email is configured, sends it. */
export async function deliverInvite(req: Request, invite: WorkspaceInvite, user: User): Promise<InviteDelivery> {
  const origin = new URL(req.url).origin || config.appUrl;
  const url = `${origin}/invite/${invite.token}`;
  const mail = getEmailProvider();
  if (!invite.email || !mail.delivers) return { url, emailed: false };
  const ws = await getWorkspace(invite.ownerId);
  try {
    await mail.send(inviteEmail({ to: invite.email, workspaceName: ws.name, inviterEmail: user.email, role: invite.role, url, expiresAt: invite.expiresAt }));
    return { url, emailed: true };
  } catch (err) {
    return { url, emailed: false, emailError: err instanceof Error ? err.message : "Email could not be sent" };
  }
}

/** Invites a workspace can send in an hour, each able to send an email. */
export const INVITES_PER_HOUR = 100;

/** The workspace's hourly invite allowance, for createInvites and reinviteExpired: `count` slots taken whole or not at all. */
export function inviteAllowance(workspaceId: string): (count: number) => boolean {
  return (count) => reserveRateLimit(`invites:${workspaceId}`, count, INVITES_PER_HOUR, 3_600_000).allowed;
}
