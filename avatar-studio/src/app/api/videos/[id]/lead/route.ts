import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { PUBLIC_ACCESS, captureVideoLead, getBrandKit, getVideo, videoLeadSchema } from "@/lib/services";
import { LOCAL_OWNER } from "@/lib/owner";
import { shareBodyFor } from "@/lib/share-body";
import { SHARE_COOKIE_MAX_AGE, shareCookieName, shareGateCookieName, shareGateValue, shareUnlocked } from "@/lib/share-lock";

export const dynamic = "force-dynamic";

/** Submissions one viewer may make per window, and one video may take from everyone together. */
const PER_CLIENT = 5;
const PER_VIDEO = 300;
const WINDOW_MS = 10 * 60 * 1000;

/** Public: a viewer gives an email at a share page's gate and gets back what the page shows past it. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    // Offline, expired, trashed, or someone's unshared video: not found, as on the share page.
    const video = await getVideo(id, PUBLIC_ACCESS, false);
    // A password-protected link asks for the password first; its gate opens only to visitors who gave it.
    if (video.shareLocked && !(await shareUnlocked(video, (await cookies()).get(shareCookieName(id))?.value))) {
      return json({ error: "Password required" }, { status: 401 });
    }
    const client = rateLimit(`videolead:${clientIp(req)}:${id}`, PER_CLIENT, WINDOW_MS);
    if (!client.allowed) return json({ error: "Too many submissions; try again later" }, { status: 429, headers: { "Retry-After": String(client.retryAfterSec) } });
    const input = videoLeadSchema.parse(await readJson(req));
    // Past the video's own cap (a flood of made-up addresses), viewers are still let through, only not
    // recorded: the gate collects emails, so turning real viewers away would be the worse failure.
    if (rateLimit(`videolead:video:${id}`, PER_VIDEO, WINDOW_MS).allowed) await captureVideoLead(video, input);
    else if (!video.shareGate) return json({ error: "This video does not ask for an email" }, { status: 404 });
    // What the share page holds back until an email is given: the player, button, download link, and transcript.
    const res = NextResponse.json({ ok: true, body: shareBodyFor(video, await getBrandKit(video.ownerId ?? LOCAL_OWNER)) });
    // Same cookie rules as the password unlock, partitioned so an embedding site's browser keeps it where third-party cookies are blocked.
    const production = process.env.NODE_ENV === "production";
    res.cookies.set(shareGateCookieName(id), shareGateValue(video), { httpOnly: true, sameSite: production ? "none" : "lax", secure: production, partitioned: production, path: "/", maxAge: SHARE_COOKIE_MAX_AGE });
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
