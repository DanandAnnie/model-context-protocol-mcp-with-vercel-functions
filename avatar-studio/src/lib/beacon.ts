import { clientIp, rateLimit } from "./rate-limit";

/**
 * True when the browser says a beacon came from another site. Browsers send Sec-Fetch-Site on
 * every fetch, so a page elsewhere cannot count views or clicks for visitors who never opened
 * the share page (an embedded share page is our own origin inside the frame). A missing
 * header (older clients, scripts) is let through; the per-viewer window still applies.
 */
export function crossSiteBeacon(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return !!site && site !== "same-origin" && site !== "none";
}

/**
 * One count per viewer per video per window, with a per-video ceiling so a loop that forges
 * the client address cannot inflate a count without bound. Checked only for a countable event.
 */
export function beaconAllowed(req: Request, kind: "view" | "cta" | `watch${number}` | `chapter${number}`, id: string, perVideo: number, windowMs: number): boolean {
  if (crossSiteBeacon(req)) return false;
  // The viewer's own window first: a repeat (a refresh) must not use up the video's ceiling.
  if (!rateLimit(`${kind}:${clientIp(req)}:${id}`, 1, windowMs).allowed) return false;
  return rateLimit(`${kind}:video:${id}`, perVideo, windowMs).allowed;
}
