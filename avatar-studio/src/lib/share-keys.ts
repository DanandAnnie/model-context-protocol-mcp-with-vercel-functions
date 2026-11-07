/**
 * Keyboard shortcuts for a share page's player, as video sites have taught viewers: K or Space plays and pauses, J and L
 * go back and forward ten seconds, the arrows five, M mutes, C turns captions on and off, F goes fullscreen, and a digit
 * jumps to that tenth of the video, and < and > go slower and faster. A plain module, so the rules can be tested without a browser.
 */

export type PlayerKeyAction =
  | { kind: "toggle-play" }
  | { kind: "seek-by"; seconds: number }
  | { kind: "seek-to"; fraction: number }
  | { kind: "mute" }
  | { kind: "captions" }
  | { kind: "fullscreen" }
  | { kind: "speed"; step: 1 | -1 };

export interface PlayerKey {
  key: string;
  /** The key's place on a US keyboard, for layouts whose letter or digit keys type something else. */
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** AltGr held: it reports Ctrl and Alt on Windows, though the character it types is the key, not a shortcut. */
  altGraph?: boolean;
  /** Held down, so sent again: a seek may repeat, a toggle may not (it would flip back and forth). */
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** Whether the single-key shortcuts (letters, digits, < and > on their own) are on: they can be turned off, for speech input. */
  singleKeys?: boolean;
  /** Where the key was pressed. */
  target: {
    /** A field the key types into (a text input, a text area, a select, or editable text). */
    editable: boolean;
    /** The player itself, whose own controls answer Space. */
    player: boolean;
    /** A button, link, checkbox, or other control, which Space and Enter press or tick. */
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
  { keys: "< / >", does: "Slower or faster" },
];

/** The speeds a viewer can choose, slowest first, as video sites offer them. */
export const PLAYER_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** The speed a step slower (-1) or faster (1) than `current` goes to, staying at the ends; from a speed between two, the next one that way. */
export function stepSpeed(current: number, step: 1 | -1): number {
  const rate = Number.isFinite(current) && current > 0 ? current : 1;
  if (step > 0) return PLAYER_SPEEDS.find((s) => s > rate + 1e-9) ?? PLAYER_SPEEDS[PLAYER_SPEEDS.length - 1];
  return [...PLAYER_SPEEDS].reverse().find((s) => s < rate - 1e-9) ?? PLAYER_SPEEDS[0];
}

/** A speed as the menu and the announcement say it: "1.25×", "Normal" for 1. */
export function speedLabel(rate: number): string {
  return Math.abs(rate - 1) < 1e-9 ? "Normal" : `${Number(rate.toFixed(2))}×`;
}

/** A speed kept from an earlier visit, if it is one of the speeds offered. */
export function storedSpeed(raw: string | null): number | null {
  const n = raw === null ? Number.NaN : Number(raw);
  return PLAYER_SPEEDS.some((s) => s === n) ? n : null;
}

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
 * "<" and ">" as a step slower or faster: by the character, however the layout types it (Shift+, and Shift+. on a US
 * keyboard, a key of its own on many European ones, AltGr on some), or, on a layout whose Shift+, and Shift+. type no
 * Latin character (Russian Б and Ю), by those keys' places.
 */
function speedOf(e: PlayerKey): PlayerKeyAction | null {
  const ch =
    e.key === "<" || e.key === ">"
      ? e.key
      : e.shiftKey && e.key.length === 1 && !LATIN.test(e.key) && (e.code === "Comma" || e.code === "Period")
        ? e.code === "Period"
          ? ">"
          : "<"
        : null;
  return ch ? { kind: "speed", step: ch === ">" ? 1 : -1 } : null;
}

/**
 * What a key pressed on the page does to the player, or nothing: keys typed into a field or while composing text, keys
 * with Ctrl, Cmd, or Alt (the browser's and the system's), Space where the focused control (a button, link, checkbox, or the like) or the player itself answers
 * it, the letter, digit, and < > shortcuts while they are turned off, and a held key's repeats of a toggle.
 */
export function playerKeyAction(e: PlayerKey): PlayerKeyAction | null {
  if (e.target.editable || e.isComposing || e.keyCode === 229 || e.metaKey) return null;
  // AltGr types < and > on some layouts (Czech AltGr+, and AltGr+.): those two only, and only while the switch is on.
  if (e.altGraph) {
    const speed = speedOf(e);
    return speed && e.singleKeys !== false ? speed : null;
  }
  if (e.ctrlKey || e.altKey) return null;
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
  const speed = speedOf(e);
  if (speed) return speed;
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
