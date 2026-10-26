// A brand kit's starting point read from a company's public web page, as HeyGen can import a brand kit from a
// website: the site's name, a logo, and its colours. Nothing is saved; the brand page fills its form for review.
//
// The page is someone else's and up to 1 MB, so nothing here may take more than linear time on it: elements are
// found with indexOf, and every regular expression runs over a short, length-capped piece with bounded repeats.
import { decodeEntities } from "./webpage";

export interface BrandSuggestion {
  /** The page the details came from, after any redirects. */
  sourceUrl: string;
  name?: string;
  /** An absolute https URL of the site's logo or icon. */
  logoUrl?: string;
  /** Lower-case `#rrggbb` colours. */
  primaryColor?: string;
  accentColor?: string;
}

/** Longest opening tag read; a longer one is skipped. */
const MAX_TAG = 4000;
/** Most elements of one kind read, and most JSON-LD nodes walked. */
const MAX_ELEMENTS = 500;
const MAX_NODES = 5000;
/** Most characters of JSON-LD or CSS read from the page. */
const MAX_BLOCK = 200_000;

interface Element {
  /** The opening tag's attribute text. */
  attrs: string;
  /** The text up to the closing tag (empty for a void element such as `<meta>`). */
  body: string;
}

/**
 * The `<tag …>` elements of `html` in order, at most `MAX_ELEMENTS`; with `closed`, each one's content up to its
 * `</tag>` (a missing closing tag ends the search). Matching is case-insensitive.
 */
function elements(html: string, lower: string, tag: string, closed: boolean): Element[] {
  const out: Element[] = [];
  let from = 0;
  while (out.length < MAX_ELEMENTS) {
    const at = lower.indexOf(`<${tag}`, from);
    if (at < 0) break;
    from = at + tag.length + 1;
    // `<metadata>` is not `<meta>`.
    if (!/[\s/>]/.test(lower[from] ?? "")) continue;
    const end = lower.indexOf(">", from);
    if (end < 0) break;
    if (end - from > MAX_TAG) {
      // Any tag opened before this point runs on to the same `>`, so it is too long as well.
      from = Math.max(from, end - MAX_TAG);
      continue;
    }
    const attrs = html.slice(from, end);
    if (!closed) {
      out.push({ attrs, body: "" });
      from = end + 1;
      continue;
    }
    const close = lower.indexOf(`</${tag}`, end + 1);
    if (close < 0) break;
    out.push({ attrs, body: html.slice(end + 1, Math.min(close, end + 1 + MAX_BLOCK)) });
    from = close;
  }
  return out;
}

/** An opening tag's attributes, names lower-cased and values decoded. */
function attributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const a of text.matchAll(/([\w:-]{1,64})\s{0,8}=\s{0,8}(?:"([^"]{0,2000})"|'([^']{0,2000})'|([^\s"'>]{1,2000}))/g)) {
    const name = a[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "").trim();
  }
  return attrs;
}

/** A CSS colour as `#rrggbb`: three-, four-, six-, or eight-digit hex (the alpha dropped) or `rgb()`/`rgba()`. */
export function normalizeColor(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase().slice(0, 64);
  if (!v) return undefined;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex && (hex.length === 3 || hex.length === 4)) return `#${[...hex.slice(0, 3)].map((c) => c + c).join("")}`;
  if (hex && (hex.length === 6 || hex.length === 8)) return `#${hex.slice(0, 6)}`;
  const rgb = /^rgba?\(\s{0,8}(\d{1,3})[\s,]{1,8}(\d{1,3})[\s,]{1,8}(\d{1,3})/.exec(v);
  if (rgb && rgb.slice(1, 4).every((n) => Number(n) <= 255)) return `#${rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  return undefined;
}

/** White, black, and greys: a header colour, not a brand's. */
function isNeutral(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

/**
 * An absolute https address for `href` on `base`: never a data URI, script, or plain-http address, since a saved logo
 * is loaded by every share page (an http one would be blocked there as mixed content).
 */
function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, base);
    return url.protocol === "https:" && url.toString().length <= 2000 ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The logo an Organization's JSON-LD names (as a string, or an ImageObject's `url`), searching nested graphs. */
function jsonLdLogo(scripts: Element[]): string | undefined {
  for (const s of scripts) {
    if (!/^application\/ld\+json$/i.test(attributes(s.attrs).type ?? "")) continue;
    let data: unknown;
    try {
      data = JSON.parse(s.body);
    } catch {
      continue;
    }
    const stack = [data];
    for (let seen = 0; stack.length && seen < MAX_NODES; seen++) {
      const node = stack.pop();
      // Children are pushed one at a time and only while there is room to visit them.
      const push = (items: unknown[]) => {
        for (const item of items) {
          if (stack.length >= MAX_NODES) break;
          stack.push(item);
        }
      };
      if (Array.isArray(node)) push(node);
      else if (node && typeof node === "object") {
        const logo = (node as { logo?: unknown }).logo;
        if (typeof logo === "string") return logo;
        if (logo && typeof logo === "object" && typeof (logo as { url?: unknown }).url === "string") return (logo as { url: string }).url;
        push(Object.values(node));
      }
    }
  }
  return undefined;
}

/** The largest side a `sizes` attribute names ("any" for a scalable icon counts as large). */
const iconSize = (sizes: string | undefined) => (sizes === "any" ? 1024 : Math.max(0, ...(sizes ?? "").slice(0, 200).split(/\s+/).map((s) => Number(s.split(/x/i)[0]) || 0)));

/**
 * The brand in a page title: of its parts ("Pricing | Acme", "Acme — Cloud tools"), the one naming the site's host,
 * else the shortest, since the others describe the page.
 */
function nameFromTitle(title: string, pageUrl: string): string {
  const parts = title.split(/\s+[|·•–—-]\s+|:\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  const host = new URL(pageUrl).hostname.replace(/^www\./, "").split(".")[0].toLowerCase();
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return parts.find((p) => host.length > 1 && (squash(p).includes(host) || host.includes(squash(p)))) ?? [...parts].sort((a, b) => a.length - b.length)[0];
}

/** Text as shown: entities decoded, any markup inside it dropped, spaces collapsed. */
const plainText = (s: string, max: number) => decodeEntities(s.slice(0, max * 4)).replace(/<[^<>]{0,200}>/g, "").replace(/\s+/g, " ").trim().slice(0, max);

/** The site's name, logo, and colours as its page declares them; anything it does not declare is left out. */
export function brandFromHtml(html: string, pageUrl: string): BrandSuggestion {
  const lower = html.toLowerCase();
  const headEnd = lower.indexOf("</head");
  const head = html.slice(0, headEnd > 0 ? headEnd : 200_000);
  const headLower = lower.slice(0, head.length);
  const metas = elements(head, headLower, "meta", false).map((e) => attributes(e.attrs));
  const meta = (key: string) => metas.find((m) => (m.property ?? m.name ?? "").toLowerCase() === key && m.content)?.content;
  const links = elements(head, headLower, "link", false)
    .map((e) => attributes(e.attrs))
    .filter((l) => l.href);
  const rel = (l: Record<string, string>) => (l.rel ?? "").toLowerCase().split(/\s+/);

  // The site's own name, else the part of the page title that names it.
  const title = plainText(elements(head, headLower, "title", true)[0]?.body ?? "", 300);
  const name = plainText(meta("og:site_name") || meta("application-name") || nameFromTitle(title, pageUrl), 80);

  // A declared logo first, then the sharpest icon: a touch icon (large and opaque), else the largest favicon.
  const touch = links.filter((l) => rel(l).some((r) => r.startsWith("apple-touch-icon")));
  const icons = links.filter((l) => rel(l).includes("icon")).sort((a, b) => iconSize(b.sizes) - iconSize(a.sizes));
  const logoUrl =
    absolute(jsonLdLogo(elements(html, lower, "script", true)), pageUrl) ?? absolute(touch[0]?.href, pageUrl) ?? icons.map((i) => absolute(i.href, pageUrl)).find(Boolean);

  // Colours the page names for itself: the browser theme (its light-scheme one first), tile and pinned-tab colours,
  // then CSS variables called primary, brand, or accent.
  const themes = metas.filter((m) => (m.name ?? "").toLowerCase() === "theme-color").sort((a, b) => Number(/dark/i.test(a.media ?? "")) - Number(/dark/i.test(b.media ?? "")));
  const declared = [...themes.map((m) => m.content), meta("msapplication-tilecolor"), ...links.filter((l) => rel(l).includes("mask-icon")).map((l) => l.color)];
  const styles = elements(html, lower, "style", true)
    .map((s) => s.body)
    .join("\n")
    .slice(0, MAX_BLOCK);
  const variables = [...styles.matchAll(/--([\w-]{1,64})\s{0,8}:\s{0,8}(#[0-9a-f]{3,8}\b|rgba?\([^()]{0,64}\))/gi)].filter((v) => /primary|brand|accent/i.test(v[1]));
  const candidates = [...declared, ...variables.filter((v) => !/accent/i.test(v[1])).map((v) => v[2])].map(normalizeColor).filter((c): c is string => !!c);
  const accents = variables.filter((v) => /accent/i.test(v[1])).map((v) => normalizeColor(v[2])).filter((c): c is string => !!c);
  const primaryColor = candidates.find((c) => !isNeutral(c)) ?? candidates[0];
  const accentColor = [...accents, ...candidates].find((c) => c !== primaryColor && !isNeutral(c));

  return { sourceUrl: pageUrl, ...(name ? { name } : {}), ...(logoUrl ? { logoUrl } : {}), ...(primaryColor ? { primaryColor } : {}), ...(accentColor ? { accentColor } : {}) };
}
