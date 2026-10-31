// Server-side fetch of user-supplied URLs. The host is vetted (public addresses only) and the
// connection is then pinned to the vetted addresses, so a DNS name that answers differently a
// moment later (rebinding) cannot steer the request to a private host.
//
// The pinned client lives only for the one request, so the body is read here (size-capped)
// before the client is torn down; callers get a plain Response with the bytes already loaded.
import type { LookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { assertPublicHttpUrl, resolvePublicHttpUrl, type ResolvedAddress } from "./safe-url";

type LookupCallback = ((err: NodeJS.ErrnoException | null, address: string, family: number) => void) &
  ((err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void);

/**
 * A `lookup` for the socket layer that ignores the name and answers with the vetted
 * addresses. Handles both callback shapes `net.connect` uses (a list when it asks for
 * `all`, otherwise one address).
 */
export function pinnedLookup(addresses: ResolvedAddress[]) {
  return (_hostname: string, options: { all?: boolean } | number, callback: LookupCallback) => {
    const list: LookupAddress[] = addresses.map((a) => ({ address: a.address, family: a.family }));
    if (typeof options === "object" && options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The response body went past the caller's cap; the read was abandoned. */
export class ResponseTooLargeError extends Error {}

export interface SafeFetchOptions {
  /** Stop reading and throw ResponseTooLargeError past this many body bytes. */
  maxBytes?: number;
  /** The caller only wants the status: drop the body as soon as the headers arrive. */
  discardBody?: boolean;
}

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Status codes a Response may not carry a body for. */
const NULL_BODY = new Set([101, 204, 205, 304]);

/** True for the error `fetch` throws on a 3xx under `redirect: "error"` (the reason sits on `cause`). */
export function isRedirectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/redirect/i.test(err.message)) return true;
  return err.cause instanceof Error && /redirect/i.test(err.cause.message);
}

/**
 * Fetch `url` after checking it points to a public host, connecting only to the addresses that
 * check saw. `fetchImpl` (tests) skips the pinning and uses the given client after the check.
 */
export async function safeFetch(url: string, init: RequestInit = {}, what = "URL", fetchImpl?: FetchLike, options: SafeFetchOptions = {}): Promise<Response> {
  if (fetchImpl) {
    await assertPublicHttpUrl(url, what);
    return fetchImpl(url, init);
  }
  const { url: parsed, addresses } = await resolvePublicHttpUrl(url, what);
  return fetchPinned(parsed, addresses, init, what, options);
}

/**
 * The pinned request itself: a one-off client whose socket lookup answers only with
 * `addresses`. Reads the whole body (up to the cap) before the client is destroyed, so the
 * returned Response can be consumed at leisure.
 */
export async function fetchPinned(url: URL, addresses: ResolvedAddress[], init: RequestInit = {}, what = "URL", options: SafeFetchOptions = {}): Promise<Response> {
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addresses) } });
  try {
    const res = await undiciFetch(url.toString(), { ...(init as UndiciRequestInit), dispatcher });
    const headers = new Headers(Array.from(res.headers.entries()));
    const bodyless = NULL_BODY.has(res.status) || !res.body;
    if (options.discardBody || bodyless) {
      await res.body?.cancel().catch(() => {});
      return new Response(null, { status: res.status, statusText: res.statusText, headers });
    }
    const bytes = await readCapped(res.body as ReadableStream<Uint8Array>, options.maxBytes ?? DEFAULT_MAX_BYTES, what);
    return new Response(bytes as BlobPart, { status: res.status, statusText: res.statusText, headers });
  } finally {
    // Nothing else can use this client; drop its sockets without waiting on them.
    await dispatcher.destroy().catch(() => {});
  }
}

async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number, what: string): Promise<Uint8Array> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(`${what} response is larger than ${Math.round(maxBytes / 1024)} KB`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
