"use client";
import { useId, useState } from "react";
import { inputClass } from "@/components/ui";
import type { AgentStyle, AgentStyleTag } from "@/lib/types";

const TAG_LABELS: Record<AgentStyleTag, string> = {
  cinematic: "Cinematic",
  "retro-tech": "Retro tech",
  "iconic-artist": "Iconic artists",
  "pop-culture": "Pop culture",
  handmade: "Handmade",
  print: "Print",
};
const SHAPES: Record<NonNullable<AgentStyle["aspect"]>, string> = { "16:9": "Landscape", "9:16": "Portrait", "1:1": "Square" };

/**
 * HeyGen's curated Video Agent styles as a choice of one (or none), filtered by group. Each card shows the style's
 * picture and the shape it is designed for, with its sample video a link away; a style filtered out stays chosen.
 */
export function AgentStylePicker({ styles, value, onChange, disabled }: { styles: AgentStyle[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const [tag, setTag] = useState<AgentStyleTag | "">("");
  const uid = useId();
  const hintId = `${uid}-hint`;
  const tags = (Object.keys(TAG_LABELS) as AgentStyleTag[]).filter((t) => styles.some((s) => s.tags.includes(t)));
  const shown = tag ? styles.filter((s) => s.tags.includes(tag)) : styles;
  const chosen = styles.find((s) => s.id === value);
  return (
    <fieldset className="min-w-0" disabled={disabled} aria-describedby={hintId}>
      <legend className="mb-1.5 block text-sm font-medium text-slate-700">Style (optional)</legend>
      <p id={hintId} className="mb-2 text-xs text-slate-500">
        A curated look HeyGen&apos;s agent composes the video in: its layouts, transitions, on-screen text, and pacing. Your brief still decides what it says.
      </p>
      {tags.length > 1 && (
        <label className="mb-2 flex items-center gap-2 text-xs text-slate-600">
          Show
          <select className={`${inputClass} w-auto py-1 text-xs`} value={tag} onChange={(e) => setTag(e.target.value as AgentStyleTag | "")}>
            <option value="">All styles</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {TAG_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className={`flex cursor-pointer flex-col justify-center gap-1 rounded-lg border p-2 text-sm ${value ? "border-slate-200" : "border-brand-500 ring-1 ring-brand-500"}`}>
          <span className="flex items-center gap-2">
            <input type="radio" name={`${uid}-style`} className="accent-brand-600" checked={!value} onChange={() => onChange("")} />
            No style
          </span>
          <span className="text-xs text-slate-500">HeyGen&apos;s agent chooses the look.</span>
        </label>
        {shown.map((s) => (
          <div key={s.id} className={`min-w-0 rounded-lg border p-2 text-sm ${value === s.id ? "border-brand-500 ring-1 ring-brand-500" : "border-slate-200"}`} data-testid="agent-style">
            <label className="block cursor-pointer">
              {s.thumbnailUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.thumbnailUrl} alt="" referrerPolicy="no-referrer" className="mb-1.5 aspect-video w-full rounded bg-slate-100 object-contain" />
              )}
              <span className="flex items-start gap-2">
                <input type="radio" name={`${uid}-style`} className="mt-0.5 accent-brand-600" checked={value === s.id} onChange={() => onChange(s.id)} />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {s.name}
                  {s.aspect && <span className="block text-xs text-slate-500">{SHAPES[s.aspect]} ({s.aspect})</span>}
                </span>
              </span>
            </label>
            {s.previewUrl && (
              <a href={s.previewUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-6 items-center text-xs font-medium text-brand-700 hover:underline" aria-label={`Watch a sample of ${s.name} (opens in a new tab)`}>
                Watch a sample
              </a>
            )}
          </div>
        ))}
      </div>
      {/* Always present, so a choice hidden by the filter is announced when it is hidden. */}
      <p className="mt-2 text-xs text-slate-600" aria-live="polite">
        {chosen && !shown.includes(chosen) ? `Chosen: ${chosen.name}` : ""}
      </p>
    </fieldset>
  );
}
