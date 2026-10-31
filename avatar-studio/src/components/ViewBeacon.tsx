"use client";
import { useEffect } from "react";

/**
 * Fires one view beacon when a share page mounts, saying whether the player is the page a viewer opened or sits in a
 * frame on another (the Embed snippet, an oEmbed player, or any page framing the link), whatever its address says.
 * Failures are ignored; counts are a convenience.
 */
export function ViewBeacon({ videoId }: { videoId: string }) {
  useEffect(() => {
    // Comparing the windows is allowed across origins, so a frame on any site is told apart from a tab.
    const framed = window.self !== window.top;
    // Repeats within the server's window are not counted, so a double mount is harmless.
    fetch(`/api/videos/${videoId}/view`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ place: framed ? "embed" : "page" }),
    }).catch(() => {});
  }, [videoId]);
  return null;
}
