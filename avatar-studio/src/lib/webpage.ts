// Turns a public web page into plain text for the script writer ("make a video from this page").
import { isRedirectError, ResponseTooLargeError, safeFetch, type FetchLike } from "./safe-fetch";
import { UnsafeUrlError } from "./safe-url";

export const MAX_PAGE_BYTES = 1_000_000;
export const MAX_SOURCE_CHARS = 6000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const key = e.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return m;
  });
}

/** Title and readable body text of an HTML document. Prefers <article> or <main>, drops nav, scripts, and styles. */
export function extractReadableText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let body = html;
  const focus = /<article[\s>][\s\S]*?<\/article>/i.exec(html)?.[0] ?? /<main[\s>][\s\S]*?<\/main>/i.exec(html)?.[0];
  if (focus) body = focus;
  body = body
    .replace(/<(script|style|noscript|template|svg|nav|header|footer|aside|form)[\s>][\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
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
      current = new URL(location, current).toString();
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
