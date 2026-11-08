"use client";

/**
 * A shared folder's button. Opens the owner's link in a new tab and sends one click beacon (a middle-click that opens it
 * in another tab counts too); the server counts a visitor once per window, and a failed beacon never blocks the link.
 */
export function CollectionCta({ collectionId, label, url, background, dark }: { collectionId: string; label: string; url: string; background: string; dark: boolean }) {
  const send = () => {
    fetch(`/api/collections/${encodeURIComponent(collectionId)}/cta`, { method: "POST", keepalive: true }).catch(() => {});
  };
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      data-testid="collection-cta"
      className="inline-flex max-w-full items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold shadow-sm [overflow-wrap:anywhere] hover:opacity-90"
      style={{ background, color: dark ? "#fff" : "#0f172a" }}
      onClick={send}
      onAuxClick={(e) => {
        if (e.button === 1) send();
      }}
    >
      {label}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
