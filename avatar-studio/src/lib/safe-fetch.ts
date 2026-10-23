// Server-side fetch of user-supplied URLs. The host is vetted (public addresses only) and the
// connection is then pinned to the vetted addresses, so a DNS name that answers differently a
// moment later (rebinding) cannot steer the request to a private host.
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

/**
 * Fetch `url` after checking it points to a public host, connecting only to the addresses that
 * check saw. `fetchImpl` (tests) skips the pinning and uses the given client after the check.
 */
export async function safeFetch(url: string, init: RequestInit = {}, what = "URL", fetchImpl?: FetchLike): Promise<Response> {
  if (fetchImpl) {
    await assertPublicHttpUrl(url, what);
    return fetchImpl(url, init);
  }
  const { url: parsed, addresses } = await resolvePublicHttpUrl(url, what);
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addresses) } });
  try {
    return (await undiciFetch(parsed.toString(), { ...(init as UndiciRequestInit), dispatcher })) as unknown as Response;
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
