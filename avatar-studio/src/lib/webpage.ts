// Turns a public web page into plain text for the script writer ("make a video from this page").
import { isRedirectError, ResponseTooLargeError, safeFetch, type FetchLike } from "./safe-fetch";
import { UnsafeUrlError } from "./safe-url";

export const MAX_PAGE_BYTES = 1_000_000;
export const MAX_SOURCE_CHARS = 6000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  // Bounded repeats keep a long run of letters or digits linear; a number that names no character stays as written.
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,32});/gi, (m, e: string) => {
    const key = e.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    const code = key.startsWith("#x") ? parseInt(key.slice(2), 16) : key.startsWith("#") ? parseInt(key.slice(1), 10) : NaN;
    return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m;
  });
}

/** Elements whose content is never part of a page's readable text. */
const UNREAD = new Set(["script", "style", "noscript", "template", "svg", "nav", "header", "footer", "aside", "form"]);
/** Elements without content, which a hidden marker hides on their own. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** How many hidden elements may be scanned for a close that never comes before hidden markers are no longer followed. */
const MAX_UNCLOSED_HIDDEN = 20;

/**
 * Upper-case ASCII letters lower-cased, and nothing else: tag names are ASCII, and a full lower-casing can change the
 * text's length (Turkish "İ" becomes two characters), which would shift every position found in it from the page's.
 */
function asciiLower(html: string): string {
  return html.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/**
 * Whether an opening tag's attributes (lower-cased) hide it from a reader: `hidden` (but not `hidden="until-found"`,
 * which a browser's find reveals), `aria-hidden="true"`, or an inline style of `display: none` or `visibility: hidden`.
 * Each attribute is read with its own value, so words inside another's value (`title="a hidden gem"`) are not markers.
 */
function hides(attrs: string): boolean {
  const attr = /([^\s"'=/<>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'<>]+))?/g;
  for (let a = attr.exec(attrs); a; a = attr.exec(attrs)) {
    const value = (a[2] ?? "").replace(/^["']|["']$/g, "").trim();
    if (a[1] === "hidden" && value !== "until-found") return true;
    if (a[1] === "aria-hidden" && value === "true") return true;
    if (a[1] === "style" && /display\s*:\s*none|visibility\s*:\s*hidden/.test(value)) return true;
  }
  return false;
}

/**
 * The page without what a reader does not see: comments, scripts, styles, navigation and the other `UNREAD` elements,
 * and, with `dropHidden`, elements marked hidden (with whatever they hold). One pass, in time linear in the page's size
 * whatever its markup: a tag's name must end where its attributes begin, so a run of letters is read once, and a
 * closing tag looked for and not found is not looked for again, so unclosed tags keep their content.
 */
function withoutUnread(html: string, lower: string, dropHidden: boolean): string {
  const tag = /<!--|<([a-z][a-z0-9-]*)(?=[\s/>])([^<>]*)>/g;
  const noClose = new Set<string>();
  let unclosedHidden = 0;
  let out = "";
  let from = 0;
  for (let m = tag.exec(lower); m; m = tag.exec(lower)) {
    if (m[0] === "<!--") {
      const end = lower.indexOf("-->", m.index + 4);
      out += `${html.slice(from, m.index)} `;
      if (end < 0) return out;
      from = tag.lastIndex = end + 3;
      continue;
    }
    const name = m[1];
    const opened = m.index + m[0].length;
    const selfClosed = m[2].trimEnd().endsWith("/");
    let skipTo = -1;
    if (UNREAD.has(name)) {
      // A self-closed `<svg/>` holds nothing; it is the tag alone that goes.
      if (selfClosed) skipTo = opened;
      else if (!noClose.has(name)) {
        const close = lower.indexOf(`</${name}>`, opened);
        if (close < 0) noClose.add(name);
        else skipTo = close + name.length + 3;
      }
    } else if (dropHidden && hides(m[2])) {
      if (VOID.has(name) || selfClosed) skipTo = opened;
      else if (unclosedHidden < MAX_UNCLOSED_HIDDEN) {
        // The matching close: elements of the same name opened inside it are counted, so a hidden div's own divs go too.
        const same = new RegExp(`<(/?)${name}(?=[\\s/>])[^<>]*>`, "g");
        same.lastIndex = opened;
        let depth = 1;
        for (let t = same.exec(lower); t; t = same.exec(lower)) {
          depth += t[1] ? -1 : 1;
          if (!depth) {
            skipTo = same.lastIndex;
            break;
          }
        }
        if (skipTo < 0) unclosedHidden++;
      }
    }
    if (skipTo < 0) continue;
    out += `${html.slice(from, m.index)} `;
    from = tag.lastIndex = skipTo;
  }
  return out + html.slice(from);
}

/** The first `<name …>…</name>` of the page, found without backtracking; none when it is never closed. */
function firstElement(html: string, lower: string, name: string): { html: string; lower: string } | undefined {
  const open = new RegExp(`<${name}[\\s>]`).exec(lower);
  if (!open) return undefined;
  const close = lower.indexOf(`</${name}>`, open.index);
  if (close < 0) return undefined;
  const end = close + name.length + 3;
  return { html: html.slice(open.index, end), lower: lower.slice(open.index, end) };
}

/**
 * Title and readable body text of an HTML document, in time linear in the page's size whatever its markup. The text is
 * the page's first `<article>`, else its `<main>` (with `preferMain`, `<main>` first: a brand's own words rather than
 * one card of its home page), else the whole page, without comments, scripts, styles, navigation, headers, footers,
 * asides, forms, templates, and svg; with `dropHidden`, elements marked hidden go too (left in by default, since an
 * answer folded away in an FAQ is still the page's to write from).
 */
export function extractReadableText(html: string, options: { dropHidden?: boolean; preferMain?: boolean } = {}): { title: string; text: string } {
  const lower = asciiLower(html);
  const titleOpen = lower.indexOf("<title");
  const titleStart = titleOpen < 0 ? -1 : lower.indexOf(">", titleOpen);
  const titleEnd = titleStart < 0 ? -1 : lower.indexOf("</title>", titleStart);
  const title = decodeEntities(titleEnd < 0 ? "" : html.slice(titleStart + 1, titleEnd)).replace(/\s+/g, " ").trim();
  const order = options.preferMain ? ["main", "article"] : ["article", "main"];
  const focus = firstElement(html, lower, order[0]) ?? firstElement(html, lower, order[1]) ?? { html, lower };
  const body = withoutUnread(focus.html, focus.lower, options.dropHidden === true)
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|blockquote)>/gi, "\n")
    .replace(/<[^<>]*>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_SOURCE_CHARS);
  return { title, text };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Fetches a public HTML page (size and time capped) and returns its HTML and the address it came from. A redirect is
 * refused unless `follow` allows that many, each hop vetted as a public address like the first.
 */
export async function fetchPageHtml(url: string, fetchImpl?: FetchLike, what = "Page URL", follow = 0): Promise<{ html: string; url: string }> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await safeFetch(
      current,
      {
        redirect: follow ? "manual" : "error",
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "AvatarStudio-ScriptWriter/1.0" },
      },
      what,
      fetchImpl,
      { maxBytes: MAX_PAGE_BYTES },
    ).catch((err) => {
      if (err instanceof UnsafeUrlError) throw err;
      if (err instanceof ResponseTooLargeError) throw new Error("The page is too large");
      throw new Error(isRedirectError(err) ? "That address redirects; paste the final page URL" : "The page could not be fetched");
    });
    if (REDIRECTS.has(res.status) && follow) {
      const location = res.headers.get("location");
      if (!location || hop >= follow) throw new Error("That address redirects too many times; paste the final page URL");
      try {
        current = new URL(location, current).toString();
      } catch {
        throw new Error("That address redirects somewhere that is not a web address; paste the final page URL");
      }
      continue;
    }
    if (!res.ok) throw new Error(`The page returned ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) throw new Error("The address is not an HTML page");
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_PAGE_BYTES) throw new Error("The page is too large");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_PAGE_BYTES) throw new Error("The page is too large");
    return { html: new TextDecoder("utf-8", { fatal: false }).decode(buf), url: current };
  }
}

/** Fetches a public page (no redirects, size and time capped) and returns its readable text. */
export async function fetchPageText(url: string, fetchImpl?: FetchLike, what = "Page URL"): Promise<{ title: string; text: string }> {
  const out = extractReadableText((await fetchPageHtml(url, fetchImpl, what)).html);
  if (out.text.length < 80) throw new Error("The page has too little readable text to write from");
  return out;
}
