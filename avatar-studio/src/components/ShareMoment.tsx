"use client";
import { useEffect, useRef, useState } from "react";
import { Link2 } from "lucide-react";
import { momentSecond, shareMomentLink } from "@/lib/share-time";
import { formatTimestamp } from "@/lib/text";

/** The whole second the player names for a link now (see `momentSecond`). */
function playerSecond(el: HTMLVideoElement): number {
  return momentSecond(el.currentTime, Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined);
}

/**
 * "Copy link at 1:05" under the share page's player: a link to this video that starts where the viewer is, so they can
 * send someone the moment they are watching. The time on the button follows the player, to the second.
 */
export function ShareMoment({ playerId, shareUrl }: { playerId: string; shareUrl: string }) {
  const [sec, setSec] = useState(0);
  const [note, setNote] = useState("");
  // Where the browser refuses the clipboard, the link is shown to copy by hand, and the focus goes to it.
  const [shown, setShown] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    const sync = () => setSec(playerSecond(el));
    sync();
    for (const type of ["timeupdate", "seeked", "durationchange"]) el.addEventListener(type, sync);
    return () => {
      for (const type of ["timeupdate", "seeked", "durationchange"]) el.removeEventListener(type, sync);
    };
  }, [playerId]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (shown) field.current?.focus();
  }, [shown]);

  /** Says `message` in the status line, emptied first so the same words twice are announced twice. */
  function say(message: string) {
    if (timer.current) clearTimeout(timer.current);
    setNote("");
    timer.current = setTimeout(() => setNote(message), 50);
  }

  async function copy() {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    // Read when pressed, not from the last update, so the link is the moment on screen.
    const at = el ? playerSecond(el) : sec;
    // The site's own share address (as the studio's copy buttons write it), without this page's query: a start, an
    // end, or embed options belonged to the link it was opened from.
    const url = shareMomentLink(shareUrl, at);
    try {
      await navigator.clipboard.writeText(url);
      setShown(null);
      say(at > 0 ? `Link at ${formatTimestamp(at)} copied.` : "Link to the start copied.");
    } catch {
      setShown(url);
      say("Copy the link from the field.");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        // A name that holds still: the time changes every second while the video plays, and a screen reader on the
        // button would read each one. The status line says the time once a link is copied.
        aria-label="Copy link at the current time"
        className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700"
        data-testid="share-moment"
      >
        <Link2 className="h-4 w-4" aria-hidden />
        <span>
          Copy link at{" "}
          {/* Wide enough for 10:00, so the row does not shift as the minutes grow. */}
          <span className="inline-block min-w-[2.6rem] text-left tabular-nums" aria-hidden>
            {formatTimestamp(sec)}
          </span>
        </span>
      </button>
      {shown && (
        <input
          ref={field}
          readOnly
          value={shown}
          aria-label="Link at this moment"
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 grow basis-56 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
        />
      )}
      {/* On a line of its own, and taking no room until it speaks. */}
      <span role="status" className={note ? "basis-full text-xs text-slate-400" : "sr-only"}>
        {note}
      </span>
    </>
  );
}
