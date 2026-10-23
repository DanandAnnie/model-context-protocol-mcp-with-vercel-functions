import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, SESSION_MAX_AGE, accessPassword, sessionToken, timingSafeEqual } from "@/lib/auth";
import { clientIp, rateLimit, resetRateLimit } from "@/lib/rate-limit";

const ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export const dynamic = "force-dynamic";

const schema = z.object({ password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  const password = accessPassword();
  if (!password) return NextResponse.json({ ok: true, authEnabled: false });
  const body = schema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Password required" }, { status: 400 });
  const key = `login:${clientIp(req)}`;
  const limit = rateLimit(key, ATTEMPTS, WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }
  if (!timingSafeEqual(body.data.password, password)) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }
  resetRateLimit(key);
  const res = NextResponse.json({ ok: true, authEnabled: true });
  res.cookies.set(SESSION_COOKIE, await sessionToken(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
