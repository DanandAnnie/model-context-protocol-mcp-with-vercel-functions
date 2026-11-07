// A visitor's last opened shared folder page, kept in their own browser so the folder's videos can link back to it.
// The share's id is the folder page's secret, so it travels in this cookie (sent only to /share pages on this site)
// rather than in a video page's address, where forwarding the address would forward the folder too.

/** The cookie's name; its value is the share id of the folder page opened last. */
export const FOLDER_VISIT_COOKIE = "folder_visit";

/** How long the way back is kept: an hour of browsing the folder's videos. */
export const FOLDER_VISIT_SECONDS = 60 * 60;
