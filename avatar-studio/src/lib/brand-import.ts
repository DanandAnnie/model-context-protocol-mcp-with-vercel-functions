// A brand kit's starting point read from a company's public web page, as HeyGen can import a brand kit from a
// website: the site's name, a logo, and its colours. Nothing is saved; the brand page fills its form for review.
import { decodeEntities } from "./webpage";

export interface BrandSuggestion {
  /** The page the details came from, after any redirects. */
  sourceUrl: string;
  name?: string;
  /** An absolute http(s) URL of the site's logo or icon. */
  logoUrl?: string;
  /** Lower-case `#rrggbb` colours. */
  primaryColor?: string;
  accentColor?: string;
}

/** The attributes of each `<tag …>` in `html`, names lower-cased and values decoded. */
function tags(html: string, tag: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const m of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "gi"))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "").trim();
    out.push(attrs);
  }
  return out;
}

/** A CSS colour as `#rrggbb`: three-, four-, six-, or eight-digit hex (the alpha dropped) or `rgb()`/`rgba()`. */
export function normalizeColor(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex && (hex.length === 3 || hex.length === 4)) return `#${[...hex.slice(0, 3)].map((c) => c + c).join("")}`;
  if (hex && (hex.length === 6 || hex.length === 8)) return `#${hex.slice(0, 6)}`;
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(v);
  if (rgb && rgb.slice(1, 4).every((n) => Number(n) <= 255)) return `#${rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  return undefined;
}

/** White, black, and greys: a header colour, not a brand's. */
function isNeutral(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

/** An absolute http(s) address for `href` on `base`, or nothing for a data URI, script, or broken value. */
function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, base);
    return /^https?:$/.test(url.protocol) && url.toString().length <= 2000 ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The logo an Organization's JSON-LD names (as a string, or an ImageObject's `url`), searching nested graphs. */
function jsonLdLogo(html: string): string | undefined {
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const stack = [data];
    for (let seen = 0; stack.length && seen < 200; seen++) {
      const node = stack.pop();
      if (Array.isArray(node)) stack.push(...node);
      else if (node && typeof node === "object") {
        const logo = (node as { logo?: unknown }).logo;
        if (typeof logo === "string") return logo;
        if (logo && typeof logo === "object" && typeof (logo as { url?: unknown }).url === "string") return (logo as { url: string }).url;
        stack.push(...Object.values(node));
      }
    }
  }
  return undefined;
}

/** The largest side a `sizes` attribute names ("any" for a scalable icon counts as large). */
const iconSize = (sizes: string | undefined) => (sizes === "any" ? 1024 : Math.max(0, ...(sizes ?? "").split(/\s+/).map((s) => Number(s.split(/x/i)[0]) || 0)));

/** The site's name, logo, and colours as its page declares them; anything it does not declare is left out. */
export function brandFromHtml(html: string, pageUrl: string): BrandSuggestion {
  const head = /<head\b[\s\S]*?<\/head>/i.exec(html)?.[0] ?? html.slice(0, 200_000);
  const metas = tags(head, "meta");
  const meta = (key: string) => metas.find((m) => (m.property ?? m.name ?? "").toLowerCase() === key && m.content)?.content;
  const links = tags(head, "link").filter((l) => l.href);
  const rel = (l: Record<string, string>) => (l.rel ?? "").toLowerCase().split(/\s+/);

  // The site's own name, else the page title's first part ("Acme | Cloud tools" → "Acme").
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const name = (meta("og:site_name") || meta("application-name") || title.split(/\s+[|·•–—-]\s+|:\s+/)[0] || "").slice(0, 80).trim();

  // A declared logo first, then the sharpest icon: a touch icon (large and opaque), else the largest favicon.
  const touch = links.filter((l) => rel(l).some((r) => r.startsWith("apple-touch-icon")));
  const icons = links.filter((l) => rel(l).includes("icon")).sort((a, b) => iconSize(b.sizes) - iconSize(a.sizes));
  const logoUrl = absolute(jsonLdLogo(html), pageUrl) ?? absolute(touch[0]?.href, pageUrl) ?? absolute(icons[0]?.href, pageUrl);

  // Colours the page names for itself: the browser theme (its light-scheme one first), tile and pinned-tab colours,
  // then CSS variables called primary, brand, or accent.
  const themes = metas.filter((m) => (m.name ?? "").toLowerCase() === "theme-color").sort((a, b) => Number(/dark/i.test(a.media ?? "")) - Number(/dark/i.test(b.media ?? "")));
  const declared = [...themes.map((m) => m.content), meta("msapplication-tilecolor"), ...links.filter((l) => rel(l).includes("mask-icon")).map((l) => l.color)];
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n").slice(0, 500_000);
  const variables = [...styles.matchAll(/--[\w-]*?(primary|brand|accent)[\w-]*\s*:\s*(#[0-9a-f]{3,8}\b|rgba?\([^)]*\))/gi)];
  const candidates = [...declared, ...variables.filter((v) => !/accent/i.test(v[1])).map((v) => v[2])].map(normalizeColor).filter((c): c is string => !!c);
  const accents = variables.filter((v) => /accent/i.test(v[1])).map((v) => normalizeColor(v[2])).filter((c): c is string => !!c);
  const primaryColor = candidates.find((c) => !isNeutral(c)) ?? candidates[0];
  const accentColor = [...accents, ...candidates].find((c) => c !== primaryColor && !isNeutral(c));

  return { sourceUrl: pageUrl, ...(name ? { name } : {}), ...(logoUrl ? { logoUrl } : {}), ...(primaryColor ? { primaryColor } : {}), ...(accentColor ? { accentColor } : {}) };
}
