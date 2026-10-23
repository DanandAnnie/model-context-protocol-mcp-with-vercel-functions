import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export { safeNextPath } from "./safe-url-client";

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true;
}

/**
 * Throws unless `url` is an http(s) URL whose host resolves only to public
 * addresses. Used before the server fetches anything a user typed in.
 */
export async function assertPublicHttpUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Image URL is not valid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Image URL must use http or https");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Image URL must point to a public host");
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("Image URL must point to a public host");
    return parsed;
  }
  const addresses = await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new Error("Image URL host could not be resolved");
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error("Image URL must point to a public host");
  return parsed;
}
