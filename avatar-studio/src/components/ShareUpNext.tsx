"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SHARE_PLAYER_ID } from "@/lib/share-player";

/** Seconds the "Up next" countdown runs before the folder's next video opens. */
export const UP_NEXT_SECONDS = 5;
/** Where a page that moved on by itself notes the video it opened, so that page starts playing (see `ShareUpNextArrival`). */
const PLAY_ON_ARRIVAL = "share-up-next";
/** How long the note is good for: the next page arrives in a moment, and a note left behind must not start a later visit. */
const ARRIVAL_WINDOW_MS = 30_000;

/**
 * Notes, in this browser tab, that the share page of `videoId` about to open should start playing (see
 * `ShareUpNextArrival`). Storage refused (a private window, blocked site data) leaves the page to open as usual.
 */
export function notePlayOnArrival(videoId: string): void {
  try {
    sessionStorage.setItem(PLAY_ON_ARRIVAL, JSON.stringify({ id: videoId, at: Date.now() }));
  } catch {
    // The page opens without starting itself.
  }
}

/**
 * Watches the share page's player and, once the video plays through to its end, counts down to the next video of the
 * shared folder the viewer came from, then opens it. Play now goes at once; Cancel, Escape, or playing the video again
 * stops the countdown and leaves the page's "Next in" card as it was. A video dragged to its end while paused does not
 * count, nor one that loops. A player in fullscreen or picture-in-picture is brought back to the page first, so the
 * countdown is seen before the page moves on.
 */
export function ShareUpNext({ href, title, nextId, loop = false }: { href: string; title: string; nextId: string; loop?: boolean }) {
  const router = useRouter();
  const [left, setLeft] = useState<number | null>(null);
  const [opening, setOpening] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigating = useRef(false);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setLeft(null);
  };
  const go = () => {
    if (navigating.current) return;
    navigating.current = true;
    stop();
    setOpening(true);
    notePlayOnArrival(nextId);
    router.push(href);
  };
  const goRef = useRef(go);
  goRef.current = go;
  const loopRef = useRef(loop);
  loopRef.current = loop;

  useEffect(() => {
    // Listened for on the document (media events reach it while capturing), so a player that comes in later, behind an
    // email form or a password, is followed too.
    const player = (e: Event) => (e.target instanceof HTMLVideoElement && e.target.id === SHARE_PLAYER_ID ? e.target : null);
    // Whether the video was playing as it ended: "pause" fires as playback reaches the end too, with `ended` already set.
    let playing = false;
    const onEnded = (e: Event) => {
      const el = player(e);
      if (!el || !playing || el.loop || loopRef.current || timer.current || navigating.current) return;
      playing = false;
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
      let n = UP_NEXT_SECONDS;
      setLeft(n);
      timer.current = setInterval(() => {
        n -= 1;
        if (n <= 0) goRef.current();
        else setLeft(n);
      }, 1000);
    };
    const onPlay = (e: Event) => {
      if (!player(e)) return;
      playing = true;
      if (timer.current) stop();
    };
    const onPause = (e: Event) => {
      const el = player(e);
      if (el && !el.ended) playing = false;
    };
    document.addEventListener("ended", onEnded, true);
    document.addEventListener("play", onPlay, true);
    document.addEventListener("pause", onPause, true);
    return () => {
      document.removeEventListener("ended", onEnded, true);
      document.removeEventListener("play", onPlay, true);
      document.removeEventListener("pause", onPause, true);
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const counting = left !== null;
  useEffect(() => {
    if (!counting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [counting]);

  return (
    <>
      {/* Kept in the page from the start; said once as the countdown begins (the seconds are for the eye only). */}
      <p role="status" className="sr-only">
        {counting ? `Up next: ${title}, in ${UP_NEXT_SECONDS} seconds. Press Escape to stay on this video.` : opening ? `Opening ${title}.` : ""}
      </p>
      {(counting || opening) && (
        // At the top of the screen, clear of the mini player that stays pinned to a bottom corner.
        <div
          className="fixed inset-x-4 top-4 z-50 mx-auto flex max-w-md flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900/95 px-4 py-3 text-sm text-slate-100 shadow-lg"
          data-testid="share-up-next"
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="block text-xs text-slate-400" aria-hidden>
              {counting ? `Up next in ${left}` : "Opening…"}
            </span>
            <span className="block font-medium">{title}</span>
          </span>
          {counting && (
            <span className="flex shrink-0 gap-2">
              <button type="button" onClick={stop} className="rounded-md border border-slate-600 px-2.5 py-1 text-xs font-medium hover:bg-slate-800">
                Cancel
              </button>
              <button type="button" onClick={go} className="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-slate-900 hover:bg-slate-200">
                Play now
              </button>
            </span>
          )}
        </div>
      )}
    </>
  );
}

/**
 * On a share page the previous one moved on to by itself, starts the video playing (with sound where the browser allows
 * it; where it does not, the viewer presses play as usual). The note is the browser tab's own, is used once, and only
 * counts for a few seconds after it was left.
 */
export function ShareUpNextArrival({ videoId }: { videoId: string }) {
  useEffect(() => {
    let noted: { id?: unknown; at?: unknown } | null = null;
    try {
      const raw = sessionStorage.getItem(PLAY_ON_ARRIVAL);
      if (raw) {
        sessionStorage.removeItem(PLAY_ON_ARRIVAL);
        noted = JSON.parse(raw);
      }
    } catch {
      return;
    }
    if (!noted || noted.id !== videoId || typeof noted.at !== "number" || Date.now() - noted.at > ARRIVAL_WINDOW_MS) return;
    const el = document.getElementById(SHARE_PLAYER_ID);
    // play() waits for the data itself; waiting for "canplay" first can wait forever where nothing loads until asked.
    // A browser that will not start it with sound is asked to start it muted: the viewer asked for the videos to play,
    // and the player's own control turns the sound on.
    if (el instanceof HTMLVideoElement)
      void el.play().catch((err: unknown) => {
        if (!(err instanceof DOMException) || err.name !== "NotAllowedError") return;
        el.muted = true;
        void el.play().catch(() => undefined);
      });
  }, [videoId]);
  return null;
}
