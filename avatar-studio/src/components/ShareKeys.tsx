"use client";
import { useEffect, useRef, useState } from "react";
import { PLAYER_SHORTCUTS, playerKeyAction, seekTarget, speedLabel, stepSpeed, toggleCaptions } from "@/lib/share-keys";
import { SINGLE_KEY_SHORTCUTS_KEY, readSingleKeyShortcuts, typesText } from "@/lib/shortcuts";
import { SHARE_TRACK_PREFIX } from "@/lib/share-player";

type WebkitVideo = HTMLVideoElement & { webkitDisplayingFullscreen?: boolean; webkitEnterFullscreen?: () => void; webkitExitFullscreen?: () => void };

/**
 * The share player's keyboard shortcuts (K, J, L, the arrows, M, C, F, the digits, and < and >), answered anywhere on the page or
 * in an embed's frame, and, on the page, a list of them under the player with a switch for the letter, digit, and < > ones
 * (the same one the studio keeps, for speech input). Muting and captions are announced, since neither shows on a
 * player whose controls are hidden.
 */
export function ShareKeys({ playerId, list = true, burnedIn = false }: { playerId: string; list?: boolean; burnedIn?: boolean }) {
  const [said, setSaid] = useState("");
  const [singleKeys, setSingleKeys] = useState(true);
  // Set once the keys are answered, for anything waiting on the page to be ready (a test, say).
  const [ready, setReady] = useState(false);
  // The captions track last shown (by C or the player's own menu), so C brings back that one (a translation), not the first.
  const lastCaptions = useRef<TextTrack | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The switch as set on this page, which holds where the browser cannot keep it (private mode); until then, the stored one.
  const switched = useRef<boolean | null>(null);

  useEffect(() => setSingleKeys(readSingleKeyShortcuts()), []);

  useEffect(() => {
    const el = document.getElementById(playerId) as HTMLVideoElement | null;
    if (!el) return;
    const remember = () => {
      const showing = Array.from(el.textTracks).find((t) => t.mode === "showing" && (t.kind === "subtitles" || t.kind === "captions"));
      if (showing) lastCaptions.current = showing;
    };
    remember();
    el.textTracks.addEventListener("change", remember);
    return () => el.textTracks.removeEventListener("change", remember);
  }, [playerId]);

  useEffect(() => {
    /** Says `message`, emptied first so the same words twice are announced twice. */
    const say = (message: string) => {
      if (timer.current) clearTimeout(timer.current);
      setSaid("");
      timer.current = setTimeout(() => setSaid(message), 50);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const el = document.getElementById(playerId) as WebkitVideo | null;
      if (!el) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const action = playerKeyAction({
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        altGraph: e.getModifierState?.("AltGraph") ?? false,
        repeat: e.repeat,
        isComposing: e.isComposing,
        keyCode: e.keyCode,
        // Read on every key, so the switch (here or in the studio, in another tab) takes effect at once.
        singleKeys: switched.current ?? readSingleKeyShortcuts(),
        target: {
          editable: typesText(t as (HTMLElement & { type?: string }) | null),
          player: t === el,
          control: !!t?.closest("button, a[href], summary, [role='button']"),
        },
      });
      if (!action) return;
      e.preventDefault();
      switch (action.kind) {
        case "toggle-play":
          if (el.paused || el.ended) void el.play().catch(() => undefined);
          else el.pause();
          return;
        case "seek-by":
        case "seek-to":
          el.currentTime = seekTarget(el.currentTime, el.duration, action);
          return;
        case "mute":
          el.muted = !el.muted;
          say(el.muted ? "Muted." : "Sound on.");
          return;
        case "captions": {
          // Captions drawn into the picture cannot be turned off; only a translation's track can be laid over them.
          const tracks = Array.from(el.textTracks).filter((tr) => !burnedIn || tr.id.startsWith(SHARE_TRACK_PREFIX));
          const result = toggleCaptions(tracks, lastCaptions.current);
          say(
            result.now === "none"
              ? burnedIn
                ? "The captions are part of this video's picture."
                : "This video has no captions."
              : result.now === "on"
                ? "Captions on."
                : "Captions off.",
          );
          return;
        }
        case "speed": {
          const next = stepSpeed(el.playbackRate, action.step);
          el.defaultPlaybackRate = next;
          el.playbackRate = next;
          say(`Speed: ${speedLabel(next)}.`);
          return;
        }
        case "fullscreen":
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
          else if (el.webkitDisplayingFullscreen) el.webkitExitFullscreen?.();
          else if (el.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
          // Safari before 16.4, and a video on an iPhone or iPad, go full screen only this way.
          else el.webkitEnterFullscreen?.();
          return;
      }
    };
    document.addEventListener("keydown", onKey);
    setReady(true);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [playerId, burnedIn]);

  return (
    <>
      <p role="status" className="sr-only" data-testid="share-keys-status" data-ready={ready || undefined}>
        {said}
      </p>
      {list && (
        <details className="mt-4 text-sm text-slate-400" data-testid="share-shortcuts">
          <summary className="cursor-pointer select-none hover:text-slate-200">Keyboard shortcuts</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {PLAYER_SHORTCUTS.map((s) => (
              <div key={s.keys} className="contents">
                <dt>
                  <kbd className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-sans text-xs text-slate-200">{s.keys}</kbd>
                </dt>
                <dd>{s.does}</dd>
              </div>
            ))}
          </dl>
          <label className="mt-3 flex items-start gap-2 text-slate-300">
            <input
              type="checkbox"
              className="mt-1"
              checked={singleKeys}
              onChange={(e) => {
                setSingleKeys(e.target.checked);
                switched.current = e.target.checked;
                try {
                  if (e.target.checked) window.localStorage.removeItem(SINGLE_KEY_SHORTCUTS_KEY);
                  else window.localStorage.setItem(SINGLE_KEY_SHORTCUTS_KEY, "off");
                } catch {
                  // Storage can be unavailable (private mode); the switch then lasts for this page only.
                }
              }}
            />
            <span>
              Letter, number, and &lt; &gt; shortcuts
              <span className="block text-xs text-slate-500">Turn them off if you use speech input or they get in your way; Space and the arrows still work. This browser remembers.</span>
            </span>
          </label>
        </details>
      )}
    </>
  );
}
