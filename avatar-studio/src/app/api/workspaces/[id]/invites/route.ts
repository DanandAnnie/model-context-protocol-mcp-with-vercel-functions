import { errorResponse, json, readJson } from "@/lib/api-utils";
import { deliverInvite } from "@/lib/invite-mail";
import { currentUser } from "@/lib/owner";
import { createInvite, inviteSchema } from "@/lib/workspaces";

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
    return json({ invite, ...(await deliverInvite(req, invite, user)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
