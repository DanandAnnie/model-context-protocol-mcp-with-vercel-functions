"use client";

/**
 * The share page's call-to-action button. Opens the link in a new tab and sends one click
 * beacon; the server counts a viewer once per window, and a failed beacon never blocks the link.
 */
export function ShareCta({ videoId, label, url, background, dark }: { videoId: string; label: string; url: string; background: string; dark: boolean }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      data-testid="share-cta"
      className="inline-flex max-w-full items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold shadow-sm [overflow-wrap:anywhere] hover:opacity-90"
      style={{ background, color: dark ? "#fff" : "#0f172a" }}
      onClick={() => {
        fetch(`/api/videos/${videoId}/cta`, { method: "POST", keepalive: true }).catch(() => {});
      }}
    >
      {label}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
