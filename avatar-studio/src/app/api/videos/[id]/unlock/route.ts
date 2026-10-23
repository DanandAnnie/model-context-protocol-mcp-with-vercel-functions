import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, json, readJson } from "@/lib/api-utils";
import { clientIp, rateLimitPair, resetRateLimit } from "@/lib/rate-limit";
import { PUBLIC_ACCESS, getVideo } from "@/lib/services";
import { SHARE_COOKIE_MAX_AGE, SHARE_PASSWORD_MAX, shareCookieName, shareCookieValue, verifySharePassword } from "@/lib/share-lock";

export const dynamic = "force-dynamic";

const ATTEMPTS = 5;
/** Attempts one video can receive from every client together per window. */
const ATTEMPTS_PER_VIDEO = 100;
const WINDOW_MS = 15 * 60 * 1000;

const schema = z.object({ password: z.string().trim().min(1).max(SHARE_PASSWORD_MAX) });

/** Public: a visitor enters the share password and receives a cookie for this video. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const video = await getVideo(id, PUBLIC_ACCESS, false);
    if (!video.shareLocked) return json({ ok: true });
    const body = schema.safeParse(await readJson(req));
    if (!body.success) return json({ error: "Password required" }, { status: 400 });
    const clientKey = `unlock:${clientIp(req)}:${id}`;
    const limit = rateLimitPair(clientKey, ATTEMPTS, `unlock:video:${id}`, ATTEMPTS_PER_VIDEO, WINDOW_MS);
    if (!limit.allowed) {
      return json({ error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes.` }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } });
    }
    const lock = await verifySharePassword(id, body.data.password);
    if (!lock) return json({ error: "Incorrect password" }, { status: 401 });
    resetRateLimit(clientKey);
    const res = NextResponse.json({ ok: true });
    // Share pages are embeddable on other sites, where only a SameSite=None cookie is sent back
    // with the framed page and its captions; that needs Secure, so it applies to production
    // (https) and local http keeps Lax. The cookie only grants read access to this one video.
    const production = process.env.NODE_ENV === "production";
    res.cookies.set(shareCookieName(id), shareCookieValue(lock), {
      httpOnly: true,
      sameSite: production ? "none" : "lax",
      secure: production,
      path: "/",
      maxAge: SHARE_COOKIE_MAX_AGE,
    });
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
