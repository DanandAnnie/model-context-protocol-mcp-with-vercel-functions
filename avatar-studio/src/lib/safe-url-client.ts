/** Accept only same-origin paths for post-login redirects: must start with a single "/" (blocks "//evil" and "/\\evil"). */
export function safeNextPath(next: string | null | undefined, fallback = "/home"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
