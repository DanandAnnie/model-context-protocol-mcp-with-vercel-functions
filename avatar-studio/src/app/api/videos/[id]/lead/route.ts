import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { clientIp, rateLimitPair } from "@/lib/rate-limit";
import { PUBLIC_ACCESS, captureVideoLead, getVideo, videoLeadSchema } from "@/lib/services";
import { SHARE_COOKIE_MAX_AGE, shareCookieName, shareGateCookieName, shareUnlocked } from "@/lib/share-lock";

export const dynamic = "force-dynamic";

/** Submissions one viewer may make per window, and one video may take from everyone together. */
const PER_CLIENT = 5;
const PER_VIDEO = 300;
const WINDOW_MS = 10 * 60 * 1000;

/** Public: a viewer gives an email at a share page's gate and is let through to the player. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    // Offline, expired, trashed, or someone's unshared video: not found, as on the share page.
    const video = await getVideo(id, PUBLIC_ACCESS, false);
    // A password-protected link asks for the password first; its gate opens only to visitors who gave it.
    if (video.shareLocked && !(await shareUnlocked(video, (await cookies()).get(shareCookieName(id))?.value))) {
      return json({ error: "Password required" }, { status: 401 });
    }
    const limit = rateLimitPair(`videolead:${clientIp(req)}:${id}`, PER_CLIENT, `videolead:video:${id}`, PER_VIDEO, WINDOW_MS);
    if (!limit.allowed) return json({ error: "Too many submissions; try again later" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    await captureVideoLead(video, videoLeadSchema.parse(await readJson(req)));
    const res = NextResponse.json({ ok: true });
    // Same cookie rules as the password unlock, so an embedded share page keeps the viewer through.
    const production = process.env.NODE_ENV === "production";
    res.cookies.set(shareGateCookieName(id), "1", { httpOnly: true, sameSite: production ? "none" : "lax", secure: production, path: "/", maxAge: SHARE_COOKIE_MAX_AGE });
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
