"use client";
import { useEffect, useId, useState } from "react";
import { PLAYER_SPEEDS, speedLabel, storedSpeed } from "@/lib/share-keys";

/** Where this browser keeps the speed a viewer last chose on a share page. */
export const SHARE_SPEED_KEY = "avatar-studio:share-speed";

/**
 * A Speed menu beside the share page's buttons: the player's playback rate, from half speed to double. It follows the
 * player whichever way the rate changes (this menu, the < and > keys, the player's own menu), and this browser keeps
 * the last one chosen for the next video it plays.
 */
export function ShareSpeed({ playerId }: { playerId: string }) {
  const id = useId();
  const [rate, setRate] = useState(1);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    let kept: number | null = null;
    try {
      kept = storedSpeed(window.localStorage.getItem(SHARE_SPEED_KEY));
    } catch {
      // Storage can be unavailable (private mode): the video plays at its normal speed.
    }
    if (kept !== null) {
      // The default too, so a reload of the source keeps it.
      el.defaultPlaybackRate = kept;
      el.playbackRate = kept;
    }
    const follow = () => {
      setRate(el.playbackRate);
      try {
        // Normal needs nothing kept; a rate this menu does not offer (from the player's own menu) is not kept either,
        // so the next visit does not bring back an older choice the viewer has since left.
        if (storedSpeed(String(el.playbackRate)) === null || Math.abs(el.playbackRate - 1) < 1e-9) window.localStorage.removeItem(SHARE_SPEED_KEY);
        else window.localStorage.setItem(SHARE_SPEED_KEY, String(el.playbackRate));
      } catch {
        // Not kept, as above.
      }
    };
    setRate(el.playbackRate);
    el.addEventListener("ratechange", follow);
    setReady(true);
    return () => el.removeEventListener("ratechange", follow);
  }, [playerId]);

  // A rate chosen in the player's own menu that this one does not offer is shown as it is, so the menu never lies.
  const offered = PLAYER_SPEEDS.some((s) => Math.abs(s - rate) < 1e-9);
  // In order, the player's own rate among them where it falls.
  const speeds = offered ? [...PLAYER_SPEEDS] : [...PLAYER_SPEEDS, rate].sort((a, b) => a - b);
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-300">
      <label htmlFor={id}>Speed</label>
      <select
        id={id}
        value={String(rate)}
        onChange={(e) => {
          const el = document.getElementById(playerId) as HTMLVideoElement | null;
          if (!el) return;
          const next = Number(e.target.value);
          setRate(next);
          el.defaultPlaybackRate = next;
          el.playbackRate = next;
        }}
        className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-2 text-sm text-slate-100"
        data-testid="share-speed"
        data-ready={ready || undefined}
      >
        {speeds.map((s) => (
          <option key={s} value={String(s)}>
            {speedLabel(s)}
          </option>
        ))}
      </select>
    </span>
  );
}
