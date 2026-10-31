"use client";
import { useEffect, useRef, useState } from "react";
import { isApple } from "@/components/QuickFind";
import { isShortcutsKey, shortcutGroups } from "@/lib/shortcuts";

const OPEN_EVENT = "shortcuts:open";

/** Opens the list of keyboard shortcuts from anywhere on the page (the sidebar's Keyboard shortcuts button). */
export function openShortcuts() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/**
 * The keyboard shortcuts (Ctrl+/ or ⌘/, or the sidebar's Keyboard shortcuts button), in a dialog that Escape, the
 * same keys, or Close shut, the focus going back where it was.
 */
export function ShortcutsHelp() {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [apple, setApple] = useState(false);

  useEffect(() => {
    setApple(isApple());
    const show = () => {
      if (dialog.current?.open) return;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      // Pressed in the dialog, the keys have closed it already.
      if (e.defaultPrevented || !isShortcutsKey(e, isApple())) return;
      // Over another dialog (quick find), the keys are left to it.
      if (document.querySelector("dialog[open]") && !dialog.current?.open) return;
      e.preventDefault();
      if (dialog.current?.open) dialog.current.close();
      else show();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) d.showModal();
  }, [open]);

  function finish() {
    setOpen(false);
    if (opener.current?.isConnected) opener.current.focus();
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="shortcuts-title"
      onClose={finish}
      onClick={(e) => e.target === dialog.current && dialog.current.close()}
      // The editor's own shortcuts (Generate on Ctrl+Enter, say) are not meant for the page behind the dialog.
      onKeyDown={(e) => {
        if (isShortcutsKey(e.nativeEvent, apple)) {
          e.preventDefault();
          dialog.current?.close();
        }
        e.stopPropagation();
      }}
      className="mt-[12vh] w-[calc(100%-2rem)] max-w-lg rounded-xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      {open && (
        <div className="p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="shortcuts-title" className="text-base font-semibold text-slate-900">
              Keyboard shortcuts
            </h2>
            <button type="button" onClick={() => dialog.current?.close()} className="rounded-md px-2 py-1 text-sm text-slate-600 hover:bg-slate-100">
              Close
            </button>
          </div>
          {/* The dialog scrolls when the list is taller than the window; a scrolling box of its own could not take the focus. */}
          <div className="space-y-4">
            {shortcutGroups(apple).map((g) => (
              <section key={g.title}>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.title}</h3>
                <dl className="divide-y divide-slate-100 text-sm">
                  {g.shortcuts.map((s) => (
                    <div key={s.does} className="flex items-start justify-between gap-4 py-1.5">
                      <dt className="text-slate-700">{s.does}</dt>
                      <dd className="flex shrink-0 flex-wrap justify-end gap-1 text-slate-500">
                        {s.keys.map((combo, i) => (
                          <span key={i} className="flex items-center gap-1">
                            {i > 0 && <span className="text-xs">or</span>}
                            {combo.map((k) => (
                              <kbd key={k} className="rounded border border-slate-200 bg-slate-50 px-1.5 font-sans text-xs text-slate-700">
                                {k}
                              </kbd>
                            ))}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      )}
    </dialog>
  );
}
