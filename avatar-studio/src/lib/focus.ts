// Handing the keyboard focus back after an action whose control went away or was disabled meanwhile.

/**
 * Focuses `el` only when the focus was lost (it sits on the page body, on a removed element, or on a disabled
 * control), so a viewer who moved on while a request was in flight is not pulled back.
 */
export function refocusIfLost(el: HTMLElement | null | undefined): void {
  if (!el || typeof document === "undefined") return;
  const active = document.activeElement as (HTMLElement & { disabled?: boolean }) | null;
  if (!active || active === document.body || !active.isConnected || active.disabled) el.focus();
}
