/**
 * Accept only same-origin paths for post-login redirects. The path must start with a single
 * "/" and contain nothing but printable ASCII: the URL parser strips tabs and newlines before
 * parsing, so "/\t/evil.com" would otherwise resolve to https://evil.com/. As a second check the
 * value is resolved against a placeholder origin and must stay on it.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/home"): string {
  if (!next || !/^\/(?![\/\\])[\x21-\x7e]*$/.test(next)) return fallback;
  try {
    const base = "http://placeholder.invalid";
    const resolved = new URL(next, base);
    if (resolved.origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return next;
}
