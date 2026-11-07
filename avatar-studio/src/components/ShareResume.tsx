"use client";
import { useEffect, useRef, useState } from "react";
import { SHARE_RESUME_KEY, placeAt, readPlaces, resumeOffer } from "@/lib/share-resume";
import { formatTimestamp } from "@/lib/text";

function load() {
  try {
    return readPlaces(window.localStorage.getItem(SHARE_RESUME_KEY));
  } catch {
    return {};
  }
}

/**
 * "Resume where you left off" under the share page's player: this browser keeps the place a viewer reached in the
 * video, and coming back to the link offers to carry on from there or start over. Only on the page, and only on a plain
 * link: one that starts at a time, plays a section, or autoplays says where (or how) to watch already.
 */
export function ShareResume({ playerId, videoId }: { playerId: string; videoId: string }) {
  const [offer, setOffer] = useState<number | null>(null);
  const group = useRef<HTMLDivElement>(null);
  // Once the viewer has chosen (Resume, Start over, or playing on), the offer does not come back this visit.
  const settled = useRef(false);

  // The offer goes without taking the keyboard with it: focus on one of its buttons moves to the player.
  const hide = (el: HTMLVideoElement | null) => {
    if (el && group.current?.contains(document.activeElement)) el.focus({ preventScroll: true });
    setOffer(null);
  };

  useEffect(() => {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    const length = () => (Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined);
    // Offered from what was kept before this visit; a length learnt later can show it (a short video's limits) or
    // withdraw it, but not bring it back once the viewer has chosen or the video is playing.
    const kept = load();
    // Playing before this script took over (the player's own controls, as the page loads) counts as playing.
    let played = !el.paused || el.played.length > 0;
    if (played) settled.current = true;
    const check = () => {
      if (settled.current || !el.paused) return hide(el);
      setOffer(resumeOffer(kept, videoId, length(), Date.now()));
    };
    check();
    // Only a viewer who plays this time moves the place: opening the page and leaving keeps the last one.
    let last = 0;
    const save = () => {
      if (!played) return;
      try {
        const next = placeAt(load(), videoId, el.ended ? Infinity : el.currentTime, length(), Date.now());
        window.localStorage.setItem(SHARE_RESUME_KEY, JSON.stringify(next));
      } catch {
        // Storage can be unavailable (private mode): nothing is kept.
      }
    };
    const onPlay = () => {
      played = true;
      // Playing on without choosing is a choice too: the offer goes.
      settled.current = true;
      hide(el);
    };
    const onTime = () => {
      if (el.paused || Date.now() - last < 5000) return;
      last = Date.now();
      save();
    };
    el.addEventListener("durationchange", check);
    el.addEventListener("play", onPlay);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("pause", save);
    el.addEventListener("ended", save);
    window.addEventListener("pagehide", save);
    return () => {
      save();
      el.removeEventListener("durationchange", check);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("pause", save);
      el.removeEventListener("ended", save);
      window.removeEventListener("pagehide", save);
    };
  }, [playerId, videoId]);

  if (offer === null) return null;
  const at = formatTimestamp(offer);
  const player = () => document.getElementById(playerId) as HTMLVideoElement | null;
  return (
    <div ref={group} role="group" aria-label="Resume watching" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200" data-testid="share-resume">
      <span>You stopped at {at} last time.</span>
      <button
        type="button"
        className="rounded-md bg-white px-3 py-1 text-xs font-medium text-slate-900 hover:bg-slate-200"
        onClick={() => {
          const el = player();
          if (!el) return;
          settled.current = true;
          el.currentTime = offer;
          // The offer goes as it plays, so the keyboard moves to the player rather than to the page.
          el.focus({ preventScroll: true });
          void el.play().catch(() => undefined);
          setOffer(null);
        }}
      >
        Resume from {at}
      </button>
      <button
        type="button"
        className="rounded-md border border-slate-600 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800"
        onClick={() => {
          settled.current = true;
          try {
            window.localStorage.setItem(SHARE_RESUME_KEY, JSON.stringify(placeAt(load(), videoId, 0, undefined, Date.now())));
          } catch {
            // Nothing kept to clear.
          }
          const el = player();
          // From the start, even if the viewer had moved the player while the offer was up.
          if (el) {
            el.currentTime = 0;
            el.focus({ preventScroll: true });
          }
          setOffer(null);
        }}
      >
        Start over
      </button>
    </div>
  );
}
