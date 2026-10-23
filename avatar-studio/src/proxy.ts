import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authEnabled, isValidSession } from "@/lib/auth";

// Paths that stay reachable without a session: the landing page, login, public
// share pages, provider webhooks, and static assets.
const PUBLIC_PREFIXES = ["/login", "/api/auth/", "/share/", "/api/webhooks/", "/_next/", "/favicon"];

export async function proxy(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (pathname === "/" || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  if (await isValidSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
