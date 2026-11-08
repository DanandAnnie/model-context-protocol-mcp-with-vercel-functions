// A visitor's last opened shared folder page, kept in their own browser so the folder's videos can link back to it.
// The share's id is the folder page's secret, so it travels in this cookie (sent only to /share pages on this site)
// rather than in a video page's address, where forwarding the address would forward the folder too.

/** The cookie's name; its value is the share id of the folder page opened last. */
export const FOLDER_VISIT_COOKIE = "folder_visit";

/** How long the way back is kept: an hour of browsing the folder's videos. */
export const FOLDER_VISIT_SECONDS = 60 * 60;

/**
 * Notes in this browser that the folder page of `collectionId` was the one opened last (browser only). The folder page
 * does it when it opens, and its Play all button again as it is pressed, so another tab's folder page opened since, or
 * a press before the page finished loading, still leaves the right folder noted.
 */
export function noteFolderVisit(collectionId: string): void {
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${FOLDER_VISIT_COOKIE}=${encodeURIComponent(collectionId)}; path=/share; max-age=${FOLDER_VISIT_SECONDS}; samesite=lax${secure}`;
}
