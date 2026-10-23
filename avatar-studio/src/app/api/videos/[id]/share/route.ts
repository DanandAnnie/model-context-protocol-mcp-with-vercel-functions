import { errorResponse, json, readJson } from "@/lib/api-utils";
import { config } from "@/lib/config";
import { currentUser, requireOwner } from "@/lib/owner";
import { getBrandKit } from "@/lib/services";
import { shareEmailSchema, shareVideoByEmail } from "@/lib/share-email";

export const dynamic = "force-dynamic";

/** Emails the share link of a finished video to up to ten recipients. Owner only. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const owner = await requireOwner();
    const input = shareEmailSchema.parse(await readJson(req));
    // The link's host comes from configuration when it is set, so a forged Host header on a
    // self-hosted instance cannot point recipients elsewhere.
    const origin = process.env.APP_URL ? config.appUrl : new URL(req.url).origin;
    const [user, brand] = await Promise.all([currentUser().catch(() => null), getBrandKit(owner)]);
    const result = await shareVideoByEmail(id, input, owner, { origin, senderId: user?.id, senderEmail: user?.email, siteName: brand?.name || undefined });
    if (result.sent.length === 0) return json({ error: result.failed[0]?.error ?? "No email could be sent", ...result }, { status: 502 });
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
