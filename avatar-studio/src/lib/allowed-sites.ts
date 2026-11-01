/**
 * The websites a shared presenter may be embedded on. Each is kept as an origin (`https://example.com`, a port when it
 * is not the default) or as every subdomain of one (`https://*.example.com`), so it can go straight into a
 * `frame-ancestors` list. Pure, so the studio's form checks what it sends the same way the server does.
 */
export const MAX_ALLOWED_SITES = 10;

// What a normalised site always looks like: nothing in it can end or extend a CSP directive.
const SAFE_SITE = /^https?:\/\/(\*\.)?[a-z0-9.\-:]+$/;

/**
 * A site as typed (`example.com`, `https://www.example.com/pricing`, `*.example.com`) as an origin, or null when it is not
 * a web address: a scheme other than http or https, a sign-in in it, or no host. A path, query, or fragment is dropped.
 */
export function normalizeSite(input: string): string | null {
  const typed = input.trim().toLowerCase();
  const parts = /^(https?:\/\/)?(\*\.)?([^\s*]+)$/.exec(typed);
  if (!parts) return null;
  const [, scheme = "https://", wildcard = "", rest] = parts;
  let url: URL;
  try {
    url = new URL(`${scheme}${rest}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) return null;
  // A single label is only a site when it is localhost; "*." needs a domain under it, not an address. A browser reads
  // neither an IPv6 address nor a name ending in a dot as a frame-ancestors source, so those are not taken.
  const host = url.hostname;
  if (host.startsWith("[") || host.endsWith(".")) return null;
  if (!host.includes(".") && host !== "localhost") return null;
  if (wildcard && (/^[\d.]+$/.test(host) || !host.includes("."))) return null;
  const site = `${url.protocol}//${wildcard}${url.host}`;
  return SAFE_SITE.test(site) ? site : null;
}

/** The sites as typed, normalised and without repeats, or the first one that is not a web address. */
export function parseSites(inputs: string[]): { sites: string[] } | { bad: string } {
  const sites: string[] = [];
  for (const input of inputs) {
    if (!input.trim()) continue;
    const site = normalizeSite(input);
    if (!site) return { bad: input.trim() };
    if (!sites.includes(site)) sites.push(site);
  }
  return { sites };
}

/** What the form's box holds (one site a line, or separated by commas or spaces) as a list. */
export function splitSites(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/** The talk page's `frame-ancestors` for a presenter's sites: the studio itself and those, and nowhere else. */
export function frameAncestors(sites: string[]): string {
  return ["frame-ancestors", "'self'", ...sites.filter((s) => SAFE_SITE.test(s))].join(" ");
}

/**
 * Whether a page at `origin` is one of the sites, as a browser reads a `frame-ancestors` source: the same scheme (an
 * http site also covers its https address), host, and port, and for `*.` any subdomain of the host but not the host itself.
 */
export function siteAllows(sites: string[], origin: string): boolean {
  let page: URL;
  try {
    page = new URL(origin);
  } catch {
    return false;
  }
  return sites.some((site) => {
    const m = /^(https?:)\/\/(\*\.)?(.+)$/.exec(site);
    if (!m) return false;
    const [, scheme, wildcard, host] = m;
    if (page.protocol !== scheme && !(scheme === "http:" && page.protocol === "https:")) return false;
    const sitePort = new URL(`${scheme}//${host}`).port;
    if (page.port !== sitePort) return false;
    const siteHost = new URL(`${scheme}//${host}`).hostname;
    return wildcard ? page.hostname.endsWith(`.${siteHost}`) : page.hostname === siteHost;
  });
}
