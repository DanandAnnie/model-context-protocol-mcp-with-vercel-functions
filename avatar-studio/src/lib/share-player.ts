/** The share player's element id, which the transcript uses to seek and follow it. A plain module, so the server page and the client components read the same string. */
export const SHARE_PLAYER_ID = "share-player";

/**
 * The id of the player's subtitle track for a translated language; the transcript matches tracks by it,
 * not by label. Built from the exact name, escaped (an id may hold anything but whitespace), so two
 * languages a video can carry never share one, whatever their script or punctuation.
 */
export function shareTrackId(language: string): string {
  return `share-track-${encodeURIComponent(language)}`;
}
