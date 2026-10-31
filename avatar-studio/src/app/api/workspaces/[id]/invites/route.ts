import { errorResponse, json, readJson } from "@/lib/api-utils";
import { config } from "@/lib/config";
import { currentUser } from "@/lib/owner";
import { getEmailProvider, inviteEmail } from "@/lib/providers/email";
import { createInvite, getWorkspace, inviteSchema } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/**
 * Creates an invite and returns the link to share. When an email address is given and an email
 * provider is configured, the invite is also sent; `emailed` reports whether that happened.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    const { id } = await ctx.params;
    const input = inviteSchema.parse(await readJson(req));
    const invite = await createInvite(id, input, user);
    const origin = new URL(req.url).origin || config.appUrl;
    const url = `${origin}/invite/${invite.token}`;
    let emailed = false;
    let emailError: string | undefined;
    const mail = getEmailProvider();
    if (invite.email && mail.delivers) {
      const ws = await getWorkspace(id);
      try {
        await mail.send(inviteEmail({ to: invite.email, workspaceName: ws.name, inviterEmail: user.email, role: invite.role, url, expiresAt: invite.expiresAt }));
        emailed = true;
      } catch (err) {
        emailError = err instanceof Error ? err.message : "Email could not be sent";
      }
    }
    return json({ invite, url, emailed, emailError }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
