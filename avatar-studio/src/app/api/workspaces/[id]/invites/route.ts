import { errorResponse, json, readJson } from "@/lib/api-utils";
import { config } from "@/lib/config";
import { currentUser } from "@/lib/owner";
import { createInvite, inviteSchema } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

/** Creates an invite and returns the link to share. Links are secrets and expire after 7 days. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentUser();
    const input = inviteSchema.parse(await readJson(req));
    const invite = await createInvite((await ctx.params).id, input, user);
    const origin = new URL(req.url).origin || config.appUrl;
    return json({ invite, url: `${origin}/invite/${invite.token}` }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
