/**
 * Keyboard shortcuts for a share page's player, as video sites have taught viewers: K or Space plays and pauses, J and L
 * go back and forward ten seconds, the arrows five, M mutes, C turns captions on and off, F goes fullscreen, and a digit
 * jumps to that tenth of the video. A plain module, so the rules can be tested without a browser.
 */

export type PlayerKeyAction =
  | { kind: "toggle-play" }
  | { kind: "seek-by"; seconds: number }
  | { kind: "seek-to"; fraction: number }
  | { kind: "mute" }
  | { kind: "captions" }
  | { kind: "fullscreen" };

export interface PlayerKey {
  key: string;
  /** The key's place on a US keyboard, for layouts whose letter or digit keys type something else. */
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** Held down, so sent again: a seek may repeat, a toggle may not (it would flip back and forth). */
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** Whether the single-key shortcuts (letters and digits on their own) are on: they can be turned off, for speech input. */
  singleKeys?: boolean;
  /** Where the key was pressed. */
  target: {
    /** A field the key types into (a text input, a text area, a select, or editable text). */
    editable: boolean;
    /** The player itself, whose own controls answer Space. */
    player: boolean;
    /** A button or link, which Space and Enter press. */
    control: boolean;
  };
}

/** The shortcuts, in the order the page lists them. */
export const PLAYER_SHORTCUTS: ReadonlyArray<{ keys: string; does: string }> = [
  { keys: "K or Space", does: "Play or pause" },
  { keys: "J / L", does: "Back or forward 10 seconds" },
  { keys: "← / →", does: "Back or forward 5 seconds" },
  { keys: "M", does: "Mute or unmute" },
  { keys: "C", does: "Captions on or off" },
  { keys: "F", does: "Full screen" },
  { keys: "0–9", does: "Jump to that tenth of the video" },
];

/** A printable character a US keyboard types, which the key itself names when the layout has one. */
const LATIN = /^[\x20-\x7e]$/;

/** The letter (a–z) a key press names: its own, or, on a layout whose key types no Latin character, the key's place. */
function letterOf(e: PlayerKey): string | null {
  const own = e.key.toLowerCase();
  if (/^[a-z]$/.test(own)) return own;
  const place = /^Key([A-Z])$/.exec(e.code ?? "");
  return place && e.key.length === 1 && !LATIN.test(e.key) ? place[1].toLowerCase() : null;
}

/** The digit a key press names: its own, or the digit row's place where it types something else unshifted (AZERTY "&é\"…"). */
function digitOf(e: PlayerKey): number | null {
  if (/^[0-9]$/.test(e.key)) return Number(e.key);
  const place = /^(?:Digit|Numpad)([0-9])$/.exec(e.code ?? "");
  return place && !e.shiftKey && !/^[a-z]$/i.test(e.key) && e.key.length === 1 ? Number(place[1]) : null;
}

/**
 * What a key pressed on the page does to the player, or nothing: keys typed into a field or while composing text, keys
 * with Ctrl, Cmd, or Alt (the browser's and the system's), Space where the focused button or the player itself answers
 * it, the letter and digit shortcuts while they are turned off, and a held key's repeats of a toggle.
 */
export function playerKeyAction(e: PlayerKey): PlayerKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.editable || e.isComposing || e.keyCode === 229) return null;
  const toggle = (action: PlayerKeyAction) => (e.repeat ? null : action);
  switch (e.key) {
    case " ":
    case "Spacebar":
      return e.target.player || e.target.control ? null : toggle({ kind: "toggle-play" });
    // Answered on the player too (unless its own controls take the key first, and so prevent it), never twice.
    case "ArrowLeft":
      return { kind: "seek-by", seconds: -5 };
    case "ArrowRight":
      return { kind: "seek-by", seconds: 5 };
  }
  if (e.singleKeys === false) return null;
  const digit = digitOf(e);
  if (digit !== null) return { kind: "seek-to", fraction: digit / 10 };
  switch (letterOf(e)) {
    case "k":
      return toggle({ kind: "toggle-play" });
    case "j":
      return { kind: "seek-by", seconds: -10 };
    case "l":
      return { kind: "seek-by", seconds: 10 };
    case "m":
      return toggle({ kind: "mute" });
    case "c":
      return toggle({ kind: "captions" });
    case "f":
      return toggle({ kind: "fullscreen" });
  }
  return null;
}

/** Where a seek lands: within the clip, from its start to its end. */
export function seekTarget(current: number, duration: number, action: Extract<PlayerKeyAction, { kind: "seek-by" | "seek-to" }>): number {
  const end = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const to = action.kind === "seek-to" ? (Number.isFinite(end) ? end * action.fraction : current) : current + action.seconds;
  return Math.max(0, Math.min(end, to));
}

/** A text track as far as turning captions on and off needs it. */
export interface CaptionTrack {
  kind: string;
  mode: string;
}

/**
 * Turns captions off when a track of words is showing, or on otherwise: `prefer` (the one last shown) if it is still
 * there, else the first. Chapters and other tracks are left alone. Says which way it went, or "none" without any.
 */
export function toggleCaptions<T extends CaptionTrack>(tracks: T[], prefer?: T | null): { now: "on" | "off" | "none"; shown?: T } {
  const words = tracks.filter((t) => t.kind === "subtitles" || t.kind === "captions");
  if (!words.length) return { now: "none" };
  const showing = words.find((t) => t.mode === "showing");
  if (showing) {
    for (const t of words) if (t.mode === "showing") t.mode = "hidden";
    return { now: "off", shown: showing };
  }
  const on = prefer && words.includes(prefer) ? prefer : words[0];
  on.mode = "showing";
  return { now: "on", shown: on };
}
