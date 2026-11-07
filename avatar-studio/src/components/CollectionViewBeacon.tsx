"use client";
import { useEffect } from "react";
import { FOLDER_VISIT_COOKIE, FOLDER_VISIT_SECONDS } from "@/lib/folder-visit";

/**
 * Fires one open beacon when a shared folder's page mounts (failures are ignored; the count is a convenience), and notes
 * the folder in this browser so its videos' share pages can link back to it without the folder's link in their address.
 */
export function CollectionViewBeacon({ collectionId }: { collectionId: string }) {
  useEffect(() => {
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${FOLDER_VISIT_COOKIE}=${encodeURIComponent(collectionId)}; path=/share; max-age=${FOLDER_VISIT_SECONDS}; samesite=lax${secure}`;
    // Repeats within the server's window are not counted, so a double mount is harmless.
    fetch(`/api/collections/${encodeURIComponent(collectionId)}/view`, { method: "POST", keepalive: true }).catch(() => {});
  }, [collectionId]);
  return null;
}
