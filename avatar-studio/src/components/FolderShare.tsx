"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Share2 } from "lucide-react";
import { api, formatDate } from "@/lib/client";

type Shared = { id: string; folder: string; url: string; views?: number; lastViewedAt?: string | null };

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
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [shift, setShift] = useState(0);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The folder shown now: a reply that arrives after the library moved to another folder is dropped.
  const current = useRef(folder);
  current.current = folder;

  // A different folder starts closed, its link not looked up yet.
  useEffect(() => {
    setOpen(false);
    setShared(undefined);
    setFailed(false);
    setNote("");
  }, [folder]);

  // Looked up afresh each time the panel opens (or Try again is pressed), so it never shows a stale link.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setShared(undefined);
    setFailed(false);
    setNote("");
    api<{ collections: Shared[] }>("/api/collections")
      .then((r) => live && setShared(r.collections.find((c) => c.folder === folder) ?? null))
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
      setNote("The folder's link no longer works.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
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
              <p className="mt-1 text-slate-500">One page lists the folder&apos;s videos whose own links can be sent now, newest first.</p>
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
                {canEdit && (
                  <button type="button" onClick={stop} disabled={busy} className="rounded-full border border-red-200 px-3 py-1 font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
                    Stop sharing
                  </button>
                )}
              </div>
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
