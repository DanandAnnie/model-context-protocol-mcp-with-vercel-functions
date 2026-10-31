"use client";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { NAV } from "@/components/nav";
import { foldTerm } from "@/lib/glossary";
import { SCRIPT_TEMPLATES } from "@/lib/templates";

const OPEN_EVENT = "quickfind:open";

/** Opens quick find from anywhere on the page (the sidebar's Search button). */
export function openQuickFind() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Whether the browser is on a Mac (or an iPad or iPhone with a keyboard), where the shortcut is ⌘K rather than Ctrl+K. */
export const isApple = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

type Result = { key: string; kind: "Page" | "Video" | "Your template" | "Template"; label: string; href: string };

/** How many videos and templates are offered for a search; the pages that match are all offered. */
const MAX_VIDEOS = 5;
const MAX_TEMPLATES = 5;

/**
 * Quick find (Ctrl+K or ⌘K, or the sidebar's Search button): one box over the studio's pages, the account's videos
 * (searched on the server by title, description, script, presenter, and voice), and its own and the stock templates.
 * The arrow keys move through the results and Enter opens one; Escape closes it and the focus goes back where it was.
 */
export function QuickFind() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Whether closing gives the focus back to what opened it (not when a result is opened: the page changes).
  const restoreFocus = useRef(true);
  const isOpen = useRef(false);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [videos, setVideos] = useState<Array<{ id: string; title: string }>>([]);
  // A video search not yet answered: the results are marked busy until it is.
  const [searching, setSearching] = useState(false);
  const [saved, setSaved] = useState<Array<{ id: string; title: string }> | null>(null);

  useEffect(() => {
    const show = () => {
      // Pressed again while it is open, it stays as it is.
      if (isOpen.current) return;
      isOpen.current = true;
      restoreFocus.current = true;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQ("");
      setActive(0);
      setVideos([]);
      // The account's templates are read again on each opening, so one saved since is offered.
      setSaved(null);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      // ⌘K on a Mac (where Ctrl+K deletes to the end of a line), Ctrl+K elsewhere; the key's place, so any layout works.
      const modifier = isApple() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      // Over another dialog (the keyboard shortcuts), the keys are left alone, so a result is never opened behind it.
      if (document.querySelector("dialog[open]") && !dialog.current?.open) return;
      if (modifier && !e.altKey && !e.shiftKey && (e.code === "KeyK" || e.key.toLowerCase() === "k")) {
        e.preventDefault();
        show();
      }
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
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!open || saved) return;
    let live = true;
    fetch("/api/templates")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((j: { templates?: Array<{ id: string; title: string }> }) => live && setSaved(j.templates ?? []))
      .catch(() => live && setSaved([]));
    return () => {
      live = false;
    };
  }, [open, saved]);

  // Videos are searched on the server once two characters are typed, a moment after the typing stops; only the latest
  // search's answer is shown, and the last search's videos go as soon as the search changes, so Enter never opens one
  // the new search did not find.
  const term = q.trim();
  useEffect(() => {
    setVideos([]);
    if (!open || term.length < 2) {
      setSearching(false);
      return;
    }
    setSearching(true);
    let live = true;
    const timer = setTimeout(async () => {
      let found: Array<{ id: string; title: string }> = [];
      try {
        const res = await fetch(`/api/videos?q=${encodeURIComponent(term)}&limit=${MAX_VIDEOS}`);
        // Refused (a session ended, say) or unreachable: no videos; the pages and templates are still offered.
        if (res.ok) found = (((await res.json()) as { videos?: Array<{ id: string; title: string }> }).videos ?? []).map((v) => ({ id: v.id, title: v.title }));
      } catch {
        found = [];
      }
      if (!live) return;
      setVideos(found);
      setSearching(false);
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [term, open]);

  const needle = foldTerm(term);
  const results = useMemo<Result[]>(() => {
    const pages: Result[] = NAV.filter((n) => !needle || foldTerm(n.label).includes(needle)).map((n) => ({ key: `page:${n.href}`, kind: "Page", label: n.label, href: n.href }));
    if (!needle) return pages;
    const found: Result[] = videos.map((v) => ({ key: `video:${v.id}`, kind: "Video", label: v.title, href: `/videos/${v.id}` }));
    const templates: Result[] = [
      ...(saved ?? []).map((t) => ({ key: `template:${t.id}`, kind: "Your template" as const, label: t.title, href: `/create?template=${t.id}` })),
      ...SCRIPT_TEMPLATES.map((t) => ({ key: `template:${t.id}`, kind: "Template" as const, label: t.title, href: `/create?template=${t.id}` })),
    ].filter((t) => foldTerm(t.label).includes(needle));
    return [...pages, ...found, ...templates.slice(0, MAX_TEMPLATES)];
  }, [needle, videos, saved]);

  // The highlighted result stays in range as the results change, and in view as it moves.
  const current = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" });
  }, [open, current, listId]);

  /** Closes the dialog; `finish` runs from its close event, once it is no longer modal and the page can take the focus. */
  function close(restore: boolean) {
    restoreFocus.current = restore;
    if (dialog.current?.open) dialog.current.close();
    else finish();
  }

  function finish() {
    if (!isOpen.current) return;
    isOpen.current = false;
    setOpen(false);
    if (restoreFocus.current && opener.current?.isConnected) opener.current.focus();
  }

  function go(r: Result) {
    close(false);
    router.push(r.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!results.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
    } else if (e.key === "Home" || e.key === "End") {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : results.length - 1);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      go(results[current]);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-label="Quick find"
      // Escape (or a click outside) closes the dialog; the focus then goes back where it was.
      onClose={finish}
      onClick={(e) => e.target === dialog.current && close(true)}
      className="mt-[12vh] w-[calc(100%-2rem)] max-w-lg rounded-xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      {open && (
        <div className="p-3">
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3">
            <Search className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            <input
              autoFocus
              type="text"
              role="combobox"
              aria-label="Find a page, video, or template"
              aria-expanded={results.length > 0}
              aria-controls={results.length ? listId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={results.length ? `${listId}-${current}` : undefined}
              placeholder="Find a page, video, or template"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              className="w-full bg-transparent py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-500"
            />
          </div>
          {results.length > 0 && (
            <ul id={listId} role="listbox" aria-label="Results" aria-busy={searching} className="mt-2 max-h-80 overflow-y-auto">
              {results.map((r, i) => (
                <li
                  key={r.key}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === current}
                  // The focus stays in the box; a click opens the result.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => i !== current && setActive(i)}
                  onClick={() => go(r)}
                  className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${i === current ? "bg-brand-50 text-brand-800" : "text-slate-700"}`}
                >
                  <span className="min-w-0 truncate">{r.label}</span>
                  <span className={`shrink-0 text-xs ${i === current ? "text-brand-700" : "text-slate-500"}`}>{r.kind}</span>
                </li>
              ))}
            </ul>
          )}
          {needle && results.length === 0 && !searching && <p className="px-3 py-2 text-sm text-slate-600">Nothing matches “{term}”.</p>}
          <p role="status" className="sr-only">
            {needle && !searching ? `${results.length} ${results.length === 1 ? "result" : "results"}` : ""}
          </p>
        </div>
      )}
    </dialog>
  );
}
