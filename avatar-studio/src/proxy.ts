import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authMode, isValidSession } from "@/lib/auth";
import { refreshSupabaseSession } from "@/lib/supabase/proxy";

// Paths that stay reachable without a session: the landing page, login, auth
// callbacks, public share pages, provider webhooks, and static assets.
const PUBLIC_PREFIXES = ["/login", "/auth/", "/api/auth/", "/share/", "/talk/", "/api/talk/", "/embed/", "/api/webhooks/", "/_next/", "/favicon"];
// Caption files back the public share player's subtitle track; view beacons come from it too.
const PUBLIC_PATTERNS = [/^\/api\/videos\/[^/]+\/captions$/, /^\/api\/videos\/[^/]+\/view$/];

export async function proxy(req: NextRequest) {
  const mode = authMode();
  if (mode === "open") return NextResponse.next();
  const { pathname } = req.nextUrl;
  const isPublic = pathname === "/" || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) || PUBLIC_PATTERNS.some((r) => r.test(pathname));
  // API calls carrying a bearer key skip the session check; the route validates the key itself.
  if (pathname.startsWith("/api/") && /^Bearer\s+\S/i.test(req.headers.get("authorization") ?? "")) return NextResponse.next();

  if (mode === "supabase") {
    // Always run the refresh so auth cookies stay current, even on public paths.
    const { response, userId } = await refreshSupabaseSession(req);
    if (isPublic || userId) return response;
    return deny(req, pathname);
  }

  if (isPublic) return NextResponse.next();
  if (await isValidSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  return deny(req, pathname);
}

function deny(req: NextRequest, pathname: string) {
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
