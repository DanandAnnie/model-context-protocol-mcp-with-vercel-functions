"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** How much of the player's place must show for the player to stay in it. */
const MINI_SHOWN = 1 / 3;

/**
 * The share page's mini player: once the video is playing and its place on the page has scrolled out of view, the
 * player is pinned small to a corner so the viewer keeps watching while reading the transcript below. It stays there
 * (paused, ended, or at a section's end note alike) until its place shows again or the viewer closes it; closing pauses
 * the video and puts the player back. A video in picture-in-picture is already watched elsewhere, so it is not pinned.
 * Only the frame's position changes (the same element, so playback, captions, and focus carry on); `slot` keeps the
 * player's room on the page meanwhile.
 */
export function useMiniPlayer(slot: RefObject<HTMLElement | null>, playerId: string, enabled: boolean) {
  const [playing, setPlaying] = useState(false);
  const [pip, setPip] = useState(false);
  const [away, setAway] = useState(false);
  const [closed, setClosed] = useState(false);
  const [mini, setMini] = useState(false);
  const closedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    const box = slot.current;
    if (!el || !box) return;
    const sync = () => {
      setPlaying(!el.paused && !el.ended);
      setPip(typeof document !== "undefined" && document.pictureInPictureElement === el);
    };
    sync();
    const events = ["play", "pause", "ended", "enterpictureinpicture", "leavepictureinpicture"];
    for (const e of events) el.addEventListener(e, sync);
    // Away once less than a third of the player's place shows (a sliver at the top of the screen is no way to watch);
    // back as soon as a third does, which also lets a closed one return.
    const seen = new IntersectionObserver(
      ([entry]) => {
        const shown = entry.isIntersecting && entry.intersectionRatio >= MINI_SHOWN;
        setAway(!shown);
        if (shown && closedRef.current) {
          closedRef.current = false;
          setClosed(false);
        }
      },
      { threshold: [0, MINI_SHOWN, 1] },
    );
    seen.observe(box);
    return () => {
      for (const e of events) el.removeEventListener(e, sync);
      seen.disconnect();
    };
  }, [enabled, playerId, slot]);

  // Playing takes it to the corner; once there it stays, whatever the video does, until it is back or closed.
  useEffect(() => {
    if (!enabled || !away || closed || pip) setMini(false);
    else if (playing) setMini(true);
  }, [enabled, away, closed, pip, playing]);

  const player = useCallback(() => document.getElementById(playerId) as HTMLVideoElement | null, [playerId]);

  const close = useCallback(() => {
    closedRef.current = true;
    setClosed(true);
    const el = player();
    el?.pause();
    // The buttons go with the mini player: the keyboard stays with the video.
    el?.focus({ preventScroll: true });
  }, [player]);

  // Back to the player's place on the page, the keyboard with it.
  const back = useCallback(() => {
    slot.current?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    player()?.focus({ preventScroll: true });
  }, [player, slot]);

  return { mini, close, back };
}
