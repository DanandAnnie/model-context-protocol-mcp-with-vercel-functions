"use client";
import { useEffect } from "react";
import { noteFolderVisit } from "@/lib/folder-visit";

/**
 * Fires one open beacon when a shared folder's page mounts (failures are ignored; the count is a convenience), and notes
 * the folder in this browser so its videos' share pages can link back to it without the folder's link in their address.
 */
export function CollectionViewBeacon({ collectionId, embed = false }: { collectionId: string; embed?: boolean }) {
  useEffect(() => {
    noteFolderVisit(collectionId);
    // Repeats within the server's window are not counted, so a double mount is harmless.
    // An open framed on a website says so, so the owner sees those apart from opens of the page itself.
    fetch(`/api/collections/${encodeURIComponent(collectionId)}/view`, {
      method: "POST",
      keepalive: true,
      ...(embed ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ place: "embed" }) } : {}),
    }).catch(() => {});
  }, [collectionId, embed]);
  return null;
}
