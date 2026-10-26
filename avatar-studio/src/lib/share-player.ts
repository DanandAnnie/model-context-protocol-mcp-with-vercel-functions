/** The share player's element id, which the transcript uses to seek and follow it. A plain module, so the server page and the client components read the same string. */
export const SHARE_PLAYER_ID = "share-player";

/** The id of the player's subtitle track for a translated language; the transcript matches tracks by it, not by label. */
export function shareTrackId(language: string): string {
  return `share-track-${language.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
