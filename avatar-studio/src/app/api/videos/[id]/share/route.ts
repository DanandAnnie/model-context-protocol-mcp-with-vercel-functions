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
    const origin = new URL(req.url).origin || config.appUrl;
    const [user, brand] = await Promise.all([currentUser().catch(() => null), getBrandKit(owner)]);
    const result = await shareVideoByEmail(id, input, owner, { origin, senderEmail: user?.email, siteName: brand?.name || undefined });
    return json(result, { status: result.sent.length ? 200 : 502 });
  } catch (err) {
    return errorResponse(err);
  }
}
