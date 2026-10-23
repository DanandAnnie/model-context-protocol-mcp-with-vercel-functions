"use client";
import { useEffect } from "react";

/** Fires one view beacon when a share page mounts. Failures are ignored; counts are a convenience. */
export function ViewBeacon({ videoId }: { videoId: string }) {
  useEffect(() => {
    // Repeats within the server's window are not counted, so a double mount is harmless.
    fetch(`/api/videos/${videoId}/view`, { method: "POST", keepalive: true }).catch(() => {});
  }, [videoId]);
  return null;
}
