import { NextResponse, type NextRequest } from "next/server";
import { API_KEY_PREFIX, SESSION_COOKIE, authMode, isValidSession } from "@/lib/auth";
import { refreshSupabaseSession } from "@/lib/supabase/proxy";
import { frameAncestors } from "@/lib/allowed-sites";
import { getStore } from "@/lib/store";
import type { Agent } from "@/lib/types";

// Paths that stay reachable without a session: the landing page, login, auth
// callbacks, public share pages (and shared folders' pages), provider webhooks, and static assets.
const PUBLIC_PREFIXES = ["/login", "/demo-consent", "/auth/", "/api/auth/", "/share/", "/collection/", "/talk/", "/api/talk/", "/embed/", "/api/webhooks/", "/api/cron/", "/api/health", "/_next/", "/favicon"];
// Caption files back the public share player's subtitle track; the view, watch, and click
// beacons, the share-password check, and the email gate come from it too. The dubbing provider
// reads a proofread's corrected lines (behind the job's own secret) without a session, and oEmbed
// consumers read a share link's embed (exactly that path, nothing under it). A shared folder's page counts its opens.
const PUBLIC_PATTERNS = [/^\/api\/oembed$/, /^\/api\/videos\/[^/]+\/(captions|cover|logo)$/, /^\/api\/videos\/[^/]+\/(view|cta|watch|unlock|lead)$/, /^\/api\/translate\/[^/]+\/srt$/, /^\/api\/collections\/[^/]+\/view$/];
// Only bundled non-private sample assets; public share pages need these without a session.
const DEMO_ASSETS = new Set(["/demo/render.mp4", "/demo/render.webm", "/demo/poster.svg", "/demo/preview.gif"]);

export async function proxy(req: NextRequest) {
  const talk = TALK_PAGE.exec(req.nextUrl.pathname);
  const [response, policy] = await Promise.all([gate(req), talk ? talkFraming(talk[1]) : null]);
  if (policy) response.headers.set("Content-Security-Policy", policy);
  return response;
}

// A shared presenter's talk page, whose framing follows the websites its owner allowed. The segment is matched before
// it is decoded, as the router decodes it (`agent%5F…` is the same page), and is read the same way here.
const TALK_PAGE = /^\/talk\/([^/]+)\/?$/;
const AGENT_ID = /^agent_[a-z0-9]{6,40}$/;

/**
 * The talk page's `frame-ancestors` when its presenter is kept to some websites, so it shows in a frame only on those
 * (and in the studio); with none set it may be framed anywhere, as before. A segment that cannot be decoded or is not
 * a presenter's id (nothing is there, so nothing is lost), or a failed read, refuses other sites' frames.
 */
async function talkFraming(segment: string): Promise<string | null> {
  try {
    const id = decodeURIComponent(segment);
    if (!AGENT_ID.test(id)) return frameAncestors([]);
    const agent = await getStore().get<Agent>("agent", id);
    return agent?.allowedSites?.length ? frameAncestors(agent.allowedSites) : null;
  } catch {
    return frameAncestors([]);
  }
}

async function gate(req: NextRequest) {
  const mode = authMode();
  if (mode === "open") return NextResponse.next();
  const { pathname } = req.nextUrl;
  const isPublic = pathname === "/" || DEMO_ASSETS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) || PUBLIC_PATTERNS.some((r) => r.test(pathname));
  // API calls carrying an API key skip the session check; the route validates the key itself
  // (requireOwner rejects unknown keys). Any other bearer value goes through the normal check.
  const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (pathname.startsWith("/api/") && bearer?.startsWith(API_KEY_PREFIX)) return NextResponse.next();

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
