"use client";
import { useId, useRef, useState } from "react";
import { useFocusAfterRender } from "@/hooks/useFocusAfterRender";
import { describeOtherUses, nameOtherUses, type OtherUse } from "@/lib/presenters";

/** Switching every other use of this presenter or voice to another one (POST /api/usage/replace), for editors. */
export interface ReplaceUses {
  /** What it is called, for the labels and the confirmation. */
  name: string;
  /** The presenters or voices it can be replaced with (not itself). */
  options: Array<{ id: string; name: string }>;
  /** Makes the change; resolves once it is saved (the page then moves the focus to its note), or throws with a message to show. */
  onReplace: (to: { id: string; name: string }) => Promise<void>;
}

/**
 * "Used by …" under a presenter or voice: the interactive presenters, templates, brand kit, and photo avatars that name
 * it (see services/usage.ts). One of each kind is named in the line itself; when a kind is counted ("2 templates"), the
 * line opens to list every name, so they are reachable by keyboard, touch, and screen reader alike. Nothing when unused.
 * With `replace`, a Replace… button under it switches every one of those uses to another presenter or voice.
 */
export function OtherUsesLine({ uses, marker, replace }: { uses: OtherUse[] | undefined; marker: Record<`data-${string}`, string>; replace?: ReplaceUses }) {
  if (!uses?.length) return null;
  const line = `Used by ${describeOtherUses(uses)}`;
  const counted = new Set(uses.map((u) => u.kind)).size < uses.length;
  return (
    <>
      {!counted ? (
        <p className="mt-1 break-words text-xs text-slate-500" {...marker}>
          {line}
        </p>
      ) : (
        <details className="mt-1 text-xs text-slate-500" {...marker}>
          <summary className="cursor-pointer break-words hover:text-slate-700">{line}</summary>
          <ul className="mt-0.5 list-disc break-words pl-4">
            {nameOtherUses(uses).map((name, i) => (
              <li key={i}>{name}</li>
            ))}
          </ul>
        </details>
      )}
      {replace && replace.options.length > 0 && <ReplaceControl replace={replace} uses={uses} />}
    </>
  );
}

function ReplaceControl({ replace, uses }: { replace: ReplaceUses; uses: OtherUse[] }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const selectId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLSelectElement>(null);
  const focusAfterRender = useFocusAfterRender();
  // Opening puts the focus on the choice; closing gives it back to the button, with the choice and any error cleared.
  const close = () => {
    setOpen(false);
    setTo("");
    setErr(null);
    focusAfterRender(() => opener.current);
  };
  if (!open) {
    return (
      <button
        ref={opener}
        type="button"
        className="mt-0.5 text-xs font-medium text-brand-700 hover:underline"
        onClick={() => {
          setOpen(true);
          focusAfterRender(() => picker.current);
        }}
        aria-label={`Replace ${replace.name} in what uses it`}
      >
        Replace…
      </button>
    );
  }
  const chosen = replace.options.find((o) => o.id === to);
  async function submit() {
    if (!chosen) return;
    if (!window.confirm(`Use “${chosen.name}” instead of “${replace.name}” in ${describeOtherUses(uses)}? Videos already made are not changed.`)) return;
    setBusy(true);
    setErr(null);
    try {
      // Saved: what used it moves to the other one, so this control goes with the line and the page focuses its note.
      await replace.onReplace(chosen);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not replace it");
      // The controls were disabled while it ran, which drops the focus: give it back to the choice to try again.
      focusAfterRender(() => picker.current);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
      <label htmlFor={selectId} className="sr-only">
        Use instead of {replace.name}
      </label>
      <select ref={picker} id={selectId} value={to} onChange={(e) => setTo(e.target.value)} disabled={busy} className="min-w-0 max-w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-xs">
        <option value="">Use instead…</option>
        {replace.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => void submit()} disabled={!chosen || busy} className="rounded bg-slate-900 px-2 py-0.5 font-medium text-white disabled:opacity-50">
        {busy ? "Replacing…" : "Replace"}
      </button>
      <button type="button" onClick={close} disabled={busy} className="px-1 text-slate-600 hover:underline">
        Cancel
      </button>
      {err && (
        <p role="alert" className="w-full text-red-700">
          {err}
        </p>
      )}
    </div>
  );
}
