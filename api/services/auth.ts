// Shared auth helpers for Mission Control.
//
// If MISSION_CONTROL_TOKEN is set, /api/invoke requires either:
//   - an mc_auth cookie matching the token, or
//   - an Authorization: Bearer <token> header
// If the env var is unset, the dashboard and invoke endpoint stay open
// (the dashboard shows an "unlocked" warning pill).

export const COOKIE_NAME = "mc_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export interface AuthState {
  /** true if MISSION_CONTROL_TOKEN is configured on the server */
  required: boolean;
  /** true if the caller presented a valid token (or auth isn't required) */
  authenticated: boolean;
}

export function getAuthState(req: Request): AuthState {
  const expected = process.env.MISSION_CONTROL_TOKEN;
  if (!expected) return { required: false, authenticated: true };

  const cookies = parseCookies(req);
  const cookieToken = cookies[COOKIE_NAME];
  if (cookieToken && timingSafeEqual(cookieToken, expected)) {
    return { required: true, authenticated: true };
  }

  const authHeader = req.headers.get("authorization") || "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (m && timingSafeEqual(m[1], expected)) {
    return { required: true, authenticated: true };
  }

  return { required: true, authenticated: false };
}

export function verifyToken(token: string): boolean {
  const expected = process.env.MISSION_CONTROL_TOKEN;
  if (!expected) return false;
  return timingSafeEqual(token, expected);
}

export function buildSessionCookie(token: string, req: Request): string {
  const secure = isSecureRequest(req);
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ].join("; ");
}

export function buildClearCookie(req: Request): string {
  const secure = isSecureRequest(req);
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie") || "";
  const out: Record<string, string> = {};
  for (const part of header.split(/;\s*/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1);
    try { out[k] = decodeURIComponent(v); }
    catch { out[k] = v; }
  }
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function isSecureRequest(req: Request): boolean {
  const fwd = req.headers.get("x-forwarded-proto");
  if (fwd) return fwd.split(",")[0].trim() === "https";
  try { return new URL(req.url).protocol === "https:"; }
  catch { return false; }
}
