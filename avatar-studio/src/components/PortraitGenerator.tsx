"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Wand2 } from "lucide-react";
import { Button, inputClass } from "@/components/ui";
import { api } from "@/lib/client";

/** How often a portrait is checked, and how long it may take before the panel stops waiting. */
const POLL_MS = 3000;
const GIVE_UP_MS = 3 * 60 * 1000;

const EXAMPLE = "A friendly real estate agent in her forties, shoulder-length dark hair, navy blazer, warm smile, bright modern office behind her, soft daylight";

/**
 * Draws a presenter who does not exist from a description (HeyGen's prompt to avatar): starts the portrait, follows it
 * until it is ready, and hands it to the photo avatar form, where it is named and saved like an upload.
 */
export function PortraitGenerator({ name, demo, current, onPortrait }: { name: string; demo: boolean; current: string; onPortrait: (imageUrl: string) => void }) {
  const id = useId();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The run in progress; a newer run, or leaving the panel, makes an older one stop quietly.
  const run = useRef(0);
  useEffect(() => () => void (run.current += 1), []);
  // The picture in the form now, so a portrait that finishes after another was chosen does not replace it unasked.
  const currentNow = useRef(current);
  currentNow.current = current;
  const [held, setHeld] = useState<string | null>(null);
  // The Draw button is disabled while it runs, which drops the focus; the outcome takes it instead.
  const noteRef = useRef<HTMLParagraphElement>(null);
  const errRef = useRef<HTMLParagraphElement>(null);
  const focusOutcome = (el: { current: HTMLElement | null }) => requestAnimationFrame(() => el.current?.focus());

  async function generate() {
    const mine = ++run.current;
    const pictureAtStart = currentNow.current;
    setHeld(null);
    setBusy(true);
    setErr(null);
    setNote("Drawing the presenter…");
    try {
      const { jobId } = await api<{ jobId: string }>("/api/avatars/generate", { method: "POST", body: JSON.stringify({ name: name.trim() || "Presenter", prompt }) });
      const started = Date.now();
      for (;;) {
        if (run.current !== mine) return;
        const out = await api<{ status: string; imageUrl?: string; error?: string }>(`/api/avatars/generate/${encodeURIComponent(jobId)}`);
        if (run.current !== mine) return;
        if (out.status === "completed" && out.imageUrl) {
          if (currentNow.current !== pictureAtStart) {
            setHeld(out.imageUrl);
            setNote("The presenter is drawn, but you chose another picture meanwhile, so the preview keeps yours.");
            focusOutcome(noteRef);
            return;
          }
          onPortrait(out.imageUrl);
          setNote("The portrait is in the preview. Name the presenter and create the avatar, or describe them again for another.");
          focusOutcome(noteRef);
          return;
        }
        if (out.status === "failed") throw new Error(out.error ?? "The presenter could not be drawn");
        if (Date.now() - started > GIVE_UP_MS) throw new Error("The portrait is taking longer than expected; try again in a few minutes");
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      if (run.current !== mine) return;
      setNote(null);
      setErr(e instanceof Error ? e.message : "The presenter could not be drawn");
      focusOutcome(errRef);
    } finally {
      if (run.current === mine) setBusy(false);
    }
  }

  const short = prompt.trim().length < 20;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3" data-testid="portrait-generator">
      <label htmlFor={`${id}-prompt`} className="mb-1.5 block text-sm font-medium text-slate-700">
        Or describe a presenter
      </label>
      <textarea
        id={`${id}-prompt`}
        aria-describedby={`${id}-hint`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        maxLength={1000}
        rows={3}
        placeholder={EXAMPLE}
        className={`${inputClass} resize-y`}
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
        Age, look, clothes, setting, light: at least 20 characters. The person is drawn by AI and does not exist.
        {demo && " In demo mode an illustrated portrait stands in."}
      </p>
      <div className="mt-2 flex items-center justify-end gap-3">
        <button type="button" onClick={() => setPrompt(EXAMPLE)} className="text-xs font-medium text-brand-700 underline">
          Use an example
        </button>
        <Button variant="secondary" className="px-3 py-1.5" onClick={generate} loading={busy} disabled={short || busy}>
          <Wand2 className="h-4 w-4" /> Draw presenter
        </Button>
      </div>
      <p ref={noteRef} tabIndex={-1} role="status" className={note ? "mt-2 text-xs text-slate-600 focus:outline-none" : "sr-only"}>
        {note ?? ""}
      </p>
      {held && (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-brand-700 underline"
          onClick={() => {
            onPortrait(held);
            setHeld(null);
            setNote("The drawn portrait is in the preview.");
            focusOutcome(noteRef);
          }}
        >
          Use the drawn portrait
        </button>
      )}
      {err && (
        <p ref={errRef} tabIndex={-1} role="alert" className="mt-2 text-xs text-rose-600 focus:outline-none">
          {err}
        </p>
      )}
    </div>
  );
}
