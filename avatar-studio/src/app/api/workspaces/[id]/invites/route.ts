import { errorResponse, json, readJson } from "@/lib/api-utils";
import { deliverInvite } from "@/lib/invite-mail";
import { currentUser } from "@/lib/owner";
import { reserveRateLimit } from "@/lib/rate-limit";
import { bulkInviteSchema, createInvite, createInvites, inviteSchema } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

const INVITES_PER_HOUR = 100;
const HOUR_MS = 3_600_000;
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
      const { invites, skipped } = await createInvites(id, bulkInviteSchema.parse(body), user, (n) => reserveRateLimit(`invites:${id}`, n, INVITES_PER_HOUR, HOUR_MS).allowed);
      const sent = [];
      // A few sends at a time, so twenty slow ones do not run one after another into the time limit.
      for (let i = 0; i < invites.length; i += SEND_AT_ONCE) {
        const chunk = invites.slice(i, i + SEND_AT_ONCE);
        sent.push(...(await Promise.all(chunk.map(async (invite) => ({ invite, ...(await deliverInvite(req, invite, user)) })))));
      }
      return json({ invites: sent, skipped }, { status: 201 });
    }
    const invite = await createInvite(id, inviteSchema.parse(body), user);
    return json({ invite, ...(await deliverInvite(req, invite, user)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
