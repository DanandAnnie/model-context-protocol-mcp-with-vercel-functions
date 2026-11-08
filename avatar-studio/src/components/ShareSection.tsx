"use client";
import { useId, useState, type RefObject } from "react";
import { Copy } from "lucide-react";
import { inputClass } from "@/components/ui";
import { sectionEmbedSnippet } from "@/lib/oembed";
import { MIN_SECTION_SEC, clockTime, parseTimeInput, shareSectionLink } from "@/lib/share-time";
import type { AspectRatio } from "@/lib/types";

/**
 * "Share a section": a share link that plays only the part between two times (`?t=` and `?end=`), then pauses with a way
 * to keep watching, for sending the one minute that matters without making a new video. Each time can be typed (`1:05`,
 * `65`, `1m5s`) or taken from the page's player where it stands.
 */
export function ShareSection({
  url,
  durationSec,
  player,
  locked,
  aspect = "16:9",
  title,
}: {
  url: string;
  durationSec?: number;
  player: RefObject<HTMLVideoElement | null>;
  locked?: boolean;
  aspect?: AspectRatio;
  /** The video's title, which the embed's frame is named after. */
  title: string;
}) {
  const id = useId();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  // What the last copy was of (the link or the embed code, as text), so the note does not outlive a change to the times.
  const [copied, setCopied] = useState<{ what: "link" | "embed"; text: string } | null>(null);
  const [failed, setFailed] = useState<"link" | "embed" | null>(null);
  const length = durationSec && durationSec > 0 ? durationSec : undefined;
  const from = start.trim() ? parseTimeInput(start) : 0;
  const to = end.trim() ? parseTimeInput(end) : undefined;
  // An end typed a moment past the video's own (its length rounded) is its end; the section is checked as it will play.
  const until = to !== undefined && length !== undefined ? Math.min(to, length) : to;
  /** What is wrong with each field, said beside it: the start on its own, the end against the start and the length. */
  const startProblem =
    from === undefined ? "Write the start as a time, like 1:05 or 65." : length !== undefined && from >= length ? `The video is ${clockTime(length)} long; start before that.` : null;
  const endProblem = !end.trim()
    ? "Choose where the section ends."
    : to === undefined
      ? "Write the end as a time, like 1:30 or 90."
      : length !== undefined && to > length + 0.5
        ? `The video is ${clockTime(length)} long; end the section by then.`
        : !startProblem && from !== undefined && until !== undefined && until < from + MIN_SECTION_SEC
          ? "End the section at least a second after it starts."
          : null;
  const link = startProblem || endProblem || from === undefined || until === undefined ? null : shareSectionLink(url, from, until);

  /** The page's player where it stands, as a time for one of the fields. */
  function playerTime(): string | null {
    const el = player.current;
    return el && Number.isFinite(el.currentTime) ? clockTime(el.currentTime) : null;
  }

  const embed = link && from !== undefined && until !== undefined ? sectionEmbedSnippet(url, aspect, `${title} (${clockTime(from)} to ${clockTime(until)})`, from, until) : null;

  async function copy(what: "link" | "embed") {
    const text = what === "link" ? link : embed;
    if (!text) return;
    setFailed(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ what, text });
    } catch {
      setFailed(what);
    }
  }

  const field = (which: "start" | "end") => {
    const value = which === "start" ? start : end;
    const set = which === "start" ? setStart : setEnd;
    const label = which === "start" ? "Section start" : "Section end";
    const message = which === "start" ? startProblem : endProblem;
    // An empty end is only not chosen yet, not wrong; the summary of a good section describes the end field too.
    const invalid = !!message && !!value.trim();
    const describedBy = which === "start" ? `${id}-start-note` : `${id}-end-note ${id}-summary`;
    return (
      <div className="min-w-0 flex-1">
        <label htmlFor={`${id}-${which}`} className="block text-xs font-medium text-slate-700">
          {which === "start" ? "Start" : "End"}
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id={`${id}-${which}`}
            className={`${inputClass} min-w-0 flex-1 py-1 text-sm tabular-nums`}
            inputMode="decimal"
            placeholder={which === "start" ? "0:00" : "1:30"}
            value={value}
            aria-label={label}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            onChange={(e) => {
              set(e.target.value);
              // A note about a copy (made, or refused) speaks for the times it was made with, so a change clears it.
              setCopied(null);
              setFailed(null);
            }}
          />
          <button
            type="button"
            className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            aria-label={`Use the player's time for the section ${which}`}
            onClick={() => {
              const t = playerTime();
              if (t === null) return;
              set(t);
              setCopied(null);
              setFailed(null);
            }}
          >
            Player time
          </button>
        </div>
        <p id={`${id}-${which}-note`} className={`mt-1 text-xs ${invalid ? "text-rose-600" : "text-slate-500"}`}>
          {message ?? ""}
        </p>
      </div>
    );
  };

  return (
    <div data-testid="share-section">
      <p className="mt-1 text-xs text-slate-500">
        A link that plays only the part between two times, then pauses with a way to keep watching. The video and its views stay as they are.{locked ? " Viewers will need the password." : ""}
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        {field("start")}
        {field("end")}
      </div>
      <p id={`${id}-summary`} className="mt-2 text-xs text-slate-500">
        {link && from !== undefined && until !== undefined ? `Plays ${clockTime(from)} to ${clockTime(until)}.` : ""}
      </p>
      {link && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input readOnly className={`${inputClass} min-w-0 grow basis-56 py-1 text-xs`} value={link} aria-label="Section link" onFocus={(e) => e.currentTarget.select()} data-testid="share-section-link" />
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
            onClick={() => void copy("link")}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden /> Copy link
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
            title="Copy an iframe snippet that plays this section on your site"
            onClick={() => void copy("embed")}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden /> Copy embed code
          </button>
        </div>
      )}
      {failed === "embed" && embed && (
        <textarea readOnly className={`${inputClass} mt-2 h-20 w-full text-xs`} value={embed} aria-label="Section embed code" onFocus={(e) => e.currentTarget.select()} />
      )}
      <p role="status" className="mt-1 text-xs text-slate-500">
        {failed === "link" && link
          ? "Copy the section link from the field."
          : failed === "embed" && embed
            ? "Copy the section's embed code from the box."
            : copied && copied.text === (copied.what === "link" ? link : embed)
              ? copied.what === "link"
                ? "Section link copied."
                : "Section embed code copied: paste it into your site's HTML."
              : ""}
      </p>
    </div>
  );
}
