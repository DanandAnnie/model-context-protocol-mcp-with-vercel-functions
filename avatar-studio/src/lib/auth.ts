// Optional single-password gate. Uses Web Crypto so it also runs in the proxy (edge) runtime.

export const SESSION_COOKIE = "studio_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function accessPassword(): string | undefined {
  const v = process.env.STUDIO_PASSWORD;
  return v && v.trim() !== "" ? v : undefined;
}

export function authEnabled(): boolean {
  return accessPassword() !== undefined;
}

/** Deterministic session token derived from the password; rotating the password logs everyone out. */
export async function sessionToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`avatar-studio:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function isValidSession(cookieValue: string | undefined): Promise<boolean> {
  const password = accessPassword();
  if (!password) return true;
  if (!cookieValue) return false;
  const expected = await sessionToken(password);
  return timingSafeEqual(cookieValue, expected);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
