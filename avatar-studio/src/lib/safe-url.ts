import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export { safeNextPath } from "./safe-url-client";

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * IPv4-mapped addresses are classified by the IPv4 they wrap, in both the dotted form DNS
 * returns ("::ffff:10.0.0.1") and the hex form the URL parser produces ("::ffff:a00:1").
 * Everything else outside global unicast (2000::/3) is loopback, link-local, unique-local,
 * NAT64, or otherwise not a public host.
 */
function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  const dotted = /^(?:0*:){2,6}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) return isPrivateIPv4(dotted[1]);
  const hex = /^(?:0*:){2,6}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !/^[23][0-9a-f]{0,3}:/.test(v);
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true;
}

/** The URL failed the public-host check (as opposed to the fetch itself failing). */
export class UnsafeUrlError extends Error {}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Throws unless `url` is an http(s) URL whose host resolves only to public addresses, and
 * returns those addresses so the caller can connect to exactly what was vetted (see
 * `safeFetch`): resolving again at connect time would let a rebinding name point the
 * request somewhere else.
 */
export async function resolvePublicHttpUrl(url: string, what = "Image URL"): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError(`${what} is not valid`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new UnsafeUrlError(`${what} must use http or https`);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError(`${what} must point to a public host`);
  }
  const literal = isIP(host);
  if (literal) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError(`${what} must point to a public host`);
    return { url: parsed, addresses: [{ address: host, family: literal === 6 ? 6 : 4 }] };
  }
  const found = await lookup(host, { all: true }).catch(() => []);
  if (found.length === 0) throw new UnsafeUrlError(`${what} host could not be resolved`);
  if (found.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError(`${what} must point to a public host`);
  return { url: parsed, addresses: found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })) };
}

/** `resolvePublicHttpUrl` for callers that only need the yes/no answer. */
export async function assertPublicHttpUrl(url: string, what = "Image URL"): Promise<URL> {
  return (await resolvePublicHttpUrl(url, what)).url;
}
