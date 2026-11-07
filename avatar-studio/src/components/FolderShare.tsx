"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Share2 } from "lucide-react";
import { api, formatDate } from "@/lib/client";
import { ShareQrCode } from "./ShareQrCode";

type Order = "newest" | "oldest" | "title";
type Shared = { id: string; folder: string; url: string; updatedAt?: string; views?: number; lastViewedAt?: string | null; title?: string | null; note?: string | null; order?: Order };

/** The page's orders as the panel names them (the server's COLLECTION_ORDERS). */
const ORDERS: { value: Order; label: string; saved: string }[] = [
  { value: "newest", label: "Newest first", saved: "newest first" },
  { value: "oldest", label: "Oldest first", saved: "oldest first" },
  { value: "title", label: "Title A–Z", saved: "by title, A to Z" },
];

/** The longest heading the folder's page shows (the server's COLLECTION_TITLE_MAX). */
const TITLE_MAX = 100;
/** The longest note the folder's page shows (the server's COLLECTION_NOTE_MAX). */
const NOTE_MAX = 500;

/**
 * The library's "Share folder" control for the folder it shows: a public page listing the folder's videos whose
 * share links can be sent now. Editors share it, copy its link, and stop sharing it; a viewer can copy a link that
 * already exists but neither starts nor stops one. Escape or the button closes the panel back onto the button.
 */
export function FolderShare({ folder, canEdit }: { folder: string; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [shared, setShared] = useState<Shared | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // The note for the folder's public page, as typed (the status line above is `note`).
  const [pageNote, setPageNote] = useState("");
  // Typed and not saved yet: the panel closing (Escape, a click elsewhere) and opening again keeps the draft.
  const draftDirty = useRef(false);
  // The page's heading as typed, kept the same way; empty shows the folder's name.
  const [pageTitle, setPageTitle] = useState("");
  const titleDirty = useRef(false);
  const titleFieldRef = useRef<HTMLInputElement>(null);
  const [failed, setFailed] = useState(false);
  // The QR code of the folder's link, shown on request so the panel stays short.
  const [showQr, setShowQr] = useState(false);
  const qrRef = useRef<HTMLDivElement>(null);
  // Shown below the fields it opens under, which on a phone can be past the bottom of the screen; brought into view.
  useEffect(() => {
    if (showQr) qrRef.current?.scrollIntoView({ block: "nearest" });
  }, [showQr]);
  const [attempt, setAttempt] = useState(0);
  const [shift, setShift] = useState(0);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const noteFieldRef = useRef<HTMLTextAreaElement>(null);
  // The order picked and not saved yet (shown at once), and one picked while an earlier pick is still saving.
  const [pendingOrder, setPendingOrder] = useState<Order | null>(null);
  const orderSaving = useRef(false);
  const queuedOrder = useRef<Order | null>(null);
  // A text save and an order save can be under way together; whichever reply is the newer write is the one kept. The
  // newest reply is also remembered, so a lookup that read the store before that write landed cannot bring back what
  // it replaced (the panel closed and opened again while a save was under way).
  const lastSaved = useRef<Shared | null>(null);
  const newer = (a: Shared | null | undefined, b: Shared) => !!a && a.id === b.id && (a.updatedAt ?? "") > (b.updatedAt ?? "");
  const keepFresher = (next: Shared) => {
    if (!newer(lastSaved.current, next)) lastSaved.current = next;
    setShared((prev) => (newer(prev, next) ? prev : next));
  };
  // After a save, focus goes back to its field only if it was lost (the save button turned disabled under it); a
  // reader who moved on to another control meanwhile is left there.
  const refocus = (field: HTMLElement | null) =>
    setTimeout(() => {
      const at = document.activeElement as HTMLElement | null;
      if (!at || at === document.body || (at as HTMLButtonElement).disabled) field?.focus();
    }, 0);
  // The folder shown now: a reply that arrives after the library moved to another folder is dropped.
  const current = useRef(folder);
  current.current = folder;

  // A different folder starts closed, its link not looked up yet.
  useEffect(() => {
    setOpen(false);
    setShared(undefined);
    setFailed(false);
    setNote("");
    setShowQr(false);
    draftDirty.current = false;
    setPageNote("");
    titleDirty.current = false;
    setPageTitle("");
    lastSaved.current = null;
    queuedOrder.current = null;
    setPendingOrder(null);
  }, [folder]);

  // Looked up afresh each time the panel opens (or Try again is pressed), so it never shows a stale link.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setShared(undefined);
    // Each opening starts with the code hidden, as the panel is short by default.
    setShowQr(false);
    setFailed(false);
    setNote("");
    api<{ collections: Shared[] }>("/api/collections")
      .then((r) => {
        if (!live) return;
        const listed = r.collections.find((c) => c.folder === folder) ?? null;
        const found = listed && newer(lastSaved.current, listed) ? lastSaved.current : listed;
        setShared(found);
        if (!draftDirty.current) setPageNote(found?.note ?? "");
        if (!titleDirty.current) setPageTitle(found?.title ?? "");
      })
      .catch((e: Error) => {
        if (!live) return;
        setFailed(true);
        setNote(e.message);
      });
    return () => {
      live = false;
    };
  }, [open, folder, attempt]);

  // The panel opens under its button but moves left as far as it must to stay on screen (16px from either edge), as
  // the button can sit near the right of a phone's screen. Measured against the library's scrolling <main>, so a
  // scrollbar is not counted as room, and again after every render: the selects beside the button can appear once the
  // library loads and push it along its row.
  const place = () => {
    const wrap = wrapRef.current;
    const panel = panelRef.current;
    if (!wrap || !panel) return;
    const left = wrap.getBoundingClientRect().left;
    const box = wrap.closest("main");
    const right = box ? box.getBoundingClientRect().left + box.clientWidth : document.documentElement.clientWidth;
    setShift(Math.max(Math.min(0, right - 16 - panel.offsetWidth - left), 16 - left));
  };
  useLayoutEffect(() => {
    if (open) place();
  });
  // Once its contents arrive the panel is taller than its first line; on a phone its fields can start below the
  // bottom of the screen, so the whole panel is brought into view (nothing moves when it is already on screen).
  const loaded = shared !== undefined;
  useEffect(() => {
    if (open && loaded) panelRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, loaded]);
  // A resize re-renders it, which places it again.
  const [, setResized] = useState(0);
  useEffect(() => {
    if (!open) return;
    const resized = () => setResized((n) => n + 1);
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, [open]);

  // A click anywhere else closes it, so it never sits over the controls around it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const share = async () => {
    setBusy(true);
    setNote("");
    try {
      const asked = folder;
      const r = await api<{ collection: Shared }>("/api/collections", { method: "POST", body: JSON.stringify({ folder }) });
      if (current.current !== asked) return;
      setShared(r.collection);
      setShowQr(false);
      setPageNote(r.collection.note ?? "");
      setPageTitle(r.collection.title ?? "");
      setNote("Folder shared. Anyone with the link can see its videos whose own links can be sent.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!shared || !window.confirm(`Stop sharing “${folder}”? Its link will stop working; the videos and their own links stay as they are.`)) return;
    setBusy(true);
    setNote("");
    try {
      const asked = folder;
      await api(`/api/collections/${encodeURIComponent(shared.id)}`, { method: "DELETE" });
      if (current.current !== asked) return;
      setShared(null);
      setShowQr(false);
      lastSaved.current = null;
      draftDirty.current = false;
      setPageNote("");
      titleDirty.current = false;
      setPageTitle("");
      setNote("The folder's link no longer works.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    if (!shared) return;
    setBusy(true);
    setNote("");
    try {
      const asked = folder;
      const r = await api<{ collection: Shared }>(`/api/collections/${encodeURIComponent(shared.id)}`, { method: "PATCH", body: JSON.stringify({ note: pageNote }) });
      if (current.current !== asked) return;
      keepFresher(r.collection);
      draftDirty.current = false;
      setPageNote(r.collection.note ?? "");
      setNote(r.collection.note ? "Note saved. The folder's page shows it under its heading." : "Note taken off the folder's page.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
      // Save note is disabled once the note is saved (and while it saves), which would leave focus nowhere.
      refocus(noteFieldRef.current);
    }
  };

  const saveTitle = async () => {
    if (!shared) return;
    setBusy(true);
    setNote("");
    try {
      const asked = folder;
      const r = await api<{ collection: Shared }>(`/api/collections/${encodeURIComponent(shared.id)}`, { method: "PATCH", body: JSON.stringify({ title: pageTitle }) });
      if (current.current !== asked) return;
      keepFresher(r.collection);
      titleDirty.current = false;
      setPageTitle(r.collection.title ?? "");
      setNote(r.collection.title ? `Title saved. The folder's page is headed “${r.collection.title}”.` : `Title taken off. The folder's page is headed “${folder}”, the folder's name.`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
      refocus(titleFieldRef.current);
    }
  };

  // Saved as soon as it is picked, and shown picked straight away. A pick made while an earlier one is saving is saved
  // after it (the latest pick wins); order saves do not wait for a note save. The select is never disabled, which would
  // drop the focus.
  const saveOrder = async (order: Order) => {
    if (!shared) return;
    setPendingOrder(order);
    queuedOrder.current = order;
    if (orderSaving.current) return;
    orderSaving.current = true;
    const asked = folder;
    let saved: Order = shared.order ?? "newest";
    try {
      while (queuedOrder.current) {
        const next: Order = queuedOrder.current;
        queuedOrder.current = null;
        if (next === saved) continue;
        setNote("");
        const r = await api<{ collection: Shared }>(`/api/collections/${encodeURIComponent(shared.id)}`, { method: "PATCH", body: JSON.stringify({ order: next }) });
        if (current.current !== asked) return;
        saved = r.collection.order ?? "newest";
        // Only the order changed: the stored note comes back too, and a draft being typed is left alone.
        keepFresher(r.collection);
        setNote(`The folder's page now lists its videos ${ORDERS.find((o) => o.value === saved)?.saved}.`);
      }
    } catch (e) {
      queuedOrder.current = null;
      setNote((e as Error).message);
    } finally {
      orderSaving.current = false;
      setPendingOrder(null);
    }
  };

  const copy = async () => {
    if (!shared) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("No clipboard");
      await navigator.clipboard.writeText(shared.url);
      setNote("Link copied.");
    } catch {
      setNote("Copy the link from the box above.");
    }
  };

  return (
    <span
      ref={wrapRef}
      className="relative"
      onBlur={(e) => {
        // Focus moving on to another control closes it (it would cover the filters under it); focus leaving the page
        // (the Open link's new tab, the Stop sharing confirm) does not.
        if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
      onKeyDown={(e) => {
        // Escape closes the panel from anywhere in it or on its button, whatever the panel holds at the moment.
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-controls="folder-share-panel"
        aria-label="Share folder"
        title="Share this folder as one link"
        className="rounded p-1.5 text-slate-500 hover:bg-slate-100"
        data-testid="folder-share-button"
      >
        <Share2 className="h-4 w-4" />
      </button>
      {open && (
        <div
          ref={panelRef}
          tabIndex={-1}
          id="folder-share-panel"
          role="group"
          aria-label={`Share the folder “${folder}”`}
          style={{ left: shift }}
          className="absolute top-full z-20 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg border focus:outline-none border-slate-200 bg-white p-3 text-xs text-slate-700 shadow-lg"
          data-testid="folder-share-panel"
        >
          <p className="font-medium text-slate-900">Share “{folder}”</p>
          {failed ? (
            <button
              type="button"
              onClick={() => {
                // The button goes while the lookup runs; focus stays in the panel so Escape still closes it.
                panelRef.current?.focus();
                setAttempt((n) => n + 1);
              }} className="mt-2 rounded-full border border-slate-200 px-3 py-1 font-medium hover:bg-slate-50" autoFocus>
              Try again
            </button>
          ) : shared === undefined ? (
            <p className="mt-2 text-slate-500">Looking for its link…</p>
          ) : shared ? (
            <>
              <p className="mt-1 text-slate-500">One page lists the folder&apos;s videos whose own links can be sent now.</p>
              <p className="mt-1 text-slate-600" data-testid="folder-share-views">
                {!shared.views ? "Not opened yet." : `Opened ${shared.views === 1 ? "once" : `${shared.views} times`}${shared.lastViewedAt ? `, last on ${formatDate(shared.lastViewedAt)}` : ""}.`}
              </p>
              <input readOnly value={shared.url} aria-label="Folder link" onFocus={(e) => e.currentTarget.select()} className="mt-2 w-full rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px]" data-testid="folder-share-url" />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={copy} className="rounded-full border border-slate-200 px-3 py-1 font-medium hover:bg-slate-50" autoFocus>
                  Copy link
                </button>
                <a href={shared.url} target="_blank" rel="noopener noreferrer" className="rounded-full border border-slate-200 px-3 py-1 font-medium hover:bg-slate-50">
                  Open
                </a>
                <button
                  type="button"
                  onClick={() => setShowQr((v) => !v)}
                  aria-expanded={showQr}
                  aria-controls={showQr ? "folder-share-qr" : undefined}
                  className="rounded-full border border-slate-200 px-3 py-1 font-medium hover:bg-slate-50"
                >
                  QR code
                </button>
                {canEdit && (
                  <button type="button" onClick={stop} disabled={busy} className="rounded-full border border-red-200 px-3 py-1 font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
                    Stop sharing
                  </button>
                )}
              </div>
              {showQr && (
                <div ref={qrRef} id="folder-share-qr" role="region" aria-label="QR code for the folder" className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2" data-testid="folder-share-qr">
                  <p className="text-slate-600">Scanning it opens the folder&apos;s page. For a sign at an open house, a flyer, or a slide.</p>
                  <ShareQrCode url={shared.url} title={shared.title || folder} subject="folder" />
                </div>
              )}
              {canEdit ? (
                <form
                  className="mt-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!busy && pageTitle.trim() !== (shared.title ?? "")) void saveTitle();
                  }}
                >
                  <label htmlFor="folder-share-page-title" className="font-medium text-slate-700">
                    Title on the page
                  </label>
                  <div className="mt-1 flex gap-2">
                    <input
                      ref={titleFieldRef}
                      id="folder-share-page-title"
                      value={pageTitle}
                      maxLength={TITLE_MAX}
                      placeholder={folder}
                      onChange={(e) => {
                        titleDirty.current = true;
                        setPageTitle(e.target.value);
                      }}
                      // Not while a save is under way: its reply would replace what was typed meanwhile.
                      readOnly={busy}
                      aria-describedby="folder-share-page-title-hint"
                      className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1"
                      data-testid="folder-share-page-title"
                    />
                    <button
                      type="submit"
                      disabled={busy || pageTitle.trim() === (shared.title ?? "")}
                      className="shrink-0 rounded-full border border-slate-200 px-3 py-1 font-medium hover:bg-slate-50 disabled:opacity-50"
                    >
                      Save title
                    </button>
                  </div>
                  <span id="folder-share-page-title-hint" className="mt-1 block text-slate-500">
                    The page&apos;s heading. Leave it empty to show the folder&apos;s name.
                  </span>
                </form>
              ) : (
                shared.title && (
                  <p className="mt-2 text-slate-600" data-testid="folder-share-page-title-text">
                    Title on the page: {shared.title}
                  </p>
                )
              )}
              {canEdit ? (
                <div className="mt-3">
                  <label htmlFor="folder-share-order" className="font-medium text-slate-700">
                    Order on the page
                  </label>
                  <select
                    id="folder-share-order"
                    value={pendingOrder ?? shared.order ?? "newest"}
                    onChange={(e) => void saveOrder(e.target.value as Order)}
                    className="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1"
                    data-testid="folder-share-order"
                  >
                    {ORDERS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <p className="mt-2 text-slate-600">Order on the page: {ORDERS.find((o) => o.value === (shared.order ?? "newest"))?.label}</p>
              )}
              {canEdit ? (
                <div className="mt-3">
                  <label htmlFor="folder-share-page-note" className="font-medium text-slate-700">
                    Note on the page
                  </label>
                  <textarea
                    ref={noteFieldRef}
                    id="folder-share-page-note"
                    value={pageNote}
                    maxLength={NOTE_MAX}
                    rows={3}
                    onChange={(e) => {
                      draftDirty.current = true;
                      setPageNote(e.target.value);
                    }}
                    // Not while a save is under way: its reply would replace what was typed meanwhile.
                    readOnly={busy}
                    aria-describedby="folder-share-page-note-hint"
                    className="mt-1 w-full rounded border border-slate-200 px-2 py-1"
                    data-testid="folder-share-page-note"
                  />
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                    <span id="folder-share-page-note-hint" className="text-slate-500">
                      Shown to viewers under the page&apos;s heading. {pageNote.length}/{NOTE_MAX}
                    </span>
                    <button
                      type="button"
                      onClick={saveNote}
                      disabled={busy || pageNote.trim() === (shared.note ?? "")}
                      className="rounded-full border border-slate-200 px-3 py-1 font-medium hover:bg-slate-50 disabled:opacity-50"
                    >
                      Save note
                    </button>
                  </div>
                </div>
              ) : (
                shared.note && (
                  <p className="mt-2 whitespace-pre-line text-slate-600" data-testid="folder-share-page-note-text">
                    Note on the page: {shared.note}
                  </p>
                )
              )}
            </>
          ) : canEdit ? (
            <>
              <p className="mt-1 text-slate-500">Make one link for this folder: a page listing its videos whose own links can be sent now. Videos with a password or an email form still ask for them.</p>
              <button type="button" onClick={share} disabled={busy} className="mt-2 rounded-full bg-brand-600 px-3 py-1 font-medium text-white hover:bg-brand-700 disabled:opacity-50" autoFocus>
                Share this folder
              </button>
            </>
          ) : (
            <p className="mt-2 text-slate-500">This folder is not shared. An editor of the workspace can share it.</p>
          )}
          <p role="status" className="mt-2 min-h-[1rem] text-slate-600" data-testid="folder-share-note">
            {note}
          </p>
        </div>
      )}
    </span>
  );
}
