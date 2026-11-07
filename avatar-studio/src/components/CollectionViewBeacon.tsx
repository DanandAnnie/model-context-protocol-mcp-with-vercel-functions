"use client";
import { useEffect } from "react";

/** Fires one open beacon when a shared folder's page mounts. Failures are ignored; the count is a convenience. */
export function CollectionViewBeacon({ collectionId }: { collectionId: string }) {
  useEffect(() => {
    // Repeats within the server's window are not counted, so a double mount is harmless.
    fetch(`/api/collections/${encodeURIComponent(collectionId)}/view`, { method: "POST", keepalive: true }).catch(() => {});
  }, [collectionId]);
  return null;
}
