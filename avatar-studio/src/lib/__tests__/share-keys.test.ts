import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PLAYER_SHORTCUTS, PLAYER_SPEEDS, playerKeyAction, seekTarget, speedLabel, stepSpeed, storedSpeed, toggleCaptions, type PlayerKey } from "../share-keys";

const page = { editable: false, player: false, control: false };
const press = (key: string, more: Partial<PlayerKey> = {}) => playerKeyAction({ key, target: page, ...more });

describe("playerKeyAction", () => {
  it("maps the video-site shortcuts", () => {
    assert.deepEqual(press("k"), { kind: "toggle-play" });
    assert.deepEqual(press("K"), { kind: "toggle-play" }, "with Caps Lock or Shift too");
    assert.deepEqual(press(" "), { kind: "toggle-play" });
    assert.deepEqual(press("j"), { kind: "seek-by", seconds: -10 });
    assert.deepEqual(press("l"), { kind: "seek-by", seconds: 10 });
    assert.deepEqual(press("ArrowLeft"), { kind: "seek-by", seconds: -5 });
    assert.deepEqual(press("ArrowRight"), { kind: "seek-by", seconds: 5 });
    assert.deepEqual(press("m"), { kind: "mute" });
    assert.deepEqual(press("c"), { kind: "captions" });
    assert.deepEqual(press("f"), { kind: "fullscreen" });
    assert.deepEqual(press("0"), { kind: "seek-to", fraction: 0 });
    assert.deepEqual(press("7"), { kind: "seek-to", fraction: 0.7 });
  });

  it("leaves keys to fields, the browser, the focused button, and the player's own controls", () => {
    assert.equal(press("k", { target: { ...page, editable: true } }), null, "typing in a field");
    assert.equal(press(" ", { target: { ...page, editable: true } }), null);
    assert.equal(press("f", { ctrlKey: true }), null, "Ctrl+F finds");
    assert.equal(press("l", { metaKey: true }), null, "Cmd+L is the address bar");
    assert.equal(press("ArrowLeft", { altKey: true }), null, "Alt+Left goes back");
    assert.equal(press(" ", { target: { ...page, control: true } }), null, "Space presses a button");
    assert.equal(press(" ", { target: { ...page, player: true } }), null, "the player plays itself");
    assert.deepEqual(press("ArrowRight", { target: { ...page, player: true } }), { kind: "seek-by", seconds: 5 }, "the listed step on the player too");
    assert.deepEqual(press("k", { target: { ...page, player: true } }), { kind: "toggle-play" }, "letters work on the player too");
    assert.equal(press("k", { isComposing: true }), null, "composing text");
    assert.equal(press("k", { keyCode: 229 }), null, "an input method's key");
    assert.deepEqual(press("ArrowRight", { target: { ...page, control: true } }), { kind: "seek-by", seconds: 5 });
    for (const k of ["a", "Enter", "Tab", "Escape", "?", "ArrowUp", "F5"]) assert.equal(press(k), null, k);
  });

  it("can turn the letter and digit shortcuts off, keeping Space and the arrows", () => {
    for (const k of ["k", "j", "l", "m", "c", "f", "5"]) assert.equal(press(k, { singleKeys: false }), null, k);
    assert.deepEqual(press(" ", { singleKeys: false }), { kind: "toggle-play" });
    assert.deepEqual(press("ArrowLeft", { singleKeys: false }), { kind: "seek-by", seconds: -5 });
  });

  it("does not repeat a toggle while its key is held, but keeps seeking", () => {
    for (const k of ["k", " ", "m", "c", "f"]) assert.equal(press(k, { repeat: true }), null, k);
    assert.deepEqual(press("l", { repeat: true }), { kind: "seek-by", seconds: 10 });
    assert.deepEqual(press("ArrowLeft", { repeat: true }), { kind: "seek-by", seconds: -5 });
  });

  it("reads a letter by the key's place on a layout that types no Latin letter, and AZERTY's digit row unshifted", () => {
    assert.deepEqual(press("л", { code: "KeyK" }), { kind: "toggle-play" }, "Russian layout, the K key");
    assert.deepEqual(press("ф", { code: "KeyA" }), null, "a key with no shortcut");
    assert.deepEqual(press("ς", { code: "KeyF" }), { kind: "fullscreen" }, "Greek layout, the F key");
    assert.equal(press(";", { code: "KeyM" }), null, "a Latin character at M's place is that character, not M");
    assert.deepEqual(press("é", { code: "Digit2" }), { kind: "seek-to", fraction: 0.2 }, "AZERTY 2 unshifted");
    assert.deepEqual(press("&", { code: "Digit1" }), { kind: "seek-to", fraction: 0.1 }, "AZERTY 1 unshifted");
    assert.equal(press("&", { code: "Digit7", shiftKey: true }), null, "Shift+7 on a US keyboard is &, not 7");
    assert.deepEqual(press("4", { code: "Numpad4" }), { kind: "seek-to", fraction: 0.4 });
  });

  it("lists the shortcuts it answers, each once", () => {
    assert.deepEqual(PLAYER_SHORTCUTS.map((s) => s.keys), ["K or Space", "J / L", "← / →", "M", "C", "F", "0–9", "< / >"]);
  });
});

describe("seekTarget", () => {
  it("stays within the clip", () => {
    assert.equal(seekTarget(30, 60, { kind: "seek-by", seconds: 10 }), 40);
    assert.equal(seekTarget(55, 60, { kind: "seek-by", seconds: 10 }), 60);
    assert.equal(seekTarget(3, 60, { kind: "seek-by", seconds: -10 }), 0);
    assert.equal(seekTarget(3, 60, { kind: "seek-to", fraction: 0.5 }), 30);
    assert.equal(seekTarget(3, Number.NaN, { kind: "seek-to", fraction: 0.5 }), 3, "a length not known yet is no jump");
    assert.equal(seekTarget(3, Number.NaN, { kind: "seek-by", seconds: 5 }), 8);
  });
});

describe("toggleCaptions", () => {
  it("turns the showing track off, and the one last shown back on", () => {
    const en = { kind: "subtitles", mode: "showing" };
    const fr = { kind: "subtitles", mode: "disabled" };
    const chapters = { kind: "chapters", mode: "hidden" };
    const tracks = [chapters, en, fr];
    const off = toggleCaptions(tracks);
    assert.equal(off.now, "off");
    assert.equal(en.mode, "hidden");
    assert.equal(chapters.mode, "hidden", "chapters are left alone");
    fr.mode = "disabled";
    const on = toggleCaptions(tracks, off.shown);
    assert.equal(on.now, "on");
    assert.equal(en.mode, "showing", "the one last shown, not the first");
    assert.equal(toggleCaptions(tracks).now, "off");
    assert.equal(toggleCaptions(tracks, { kind: "subtitles", mode: "hidden" }).now, "on");
    assert.equal(en.mode, "showing", "a track no longer there falls back to the first");
    assert.deepEqual(toggleCaptions([chapters]), { now: "none" });
  });
});

describe("playback speed", () => {
  it("< and > step slower and faster, by the character, under the single-key switch", () => {
    assert.deepEqual(press(">", { shiftKey: true, code: "Period" }), { kind: "speed", step: 1 });
    assert.deepEqual(press("<", { shiftKey: true, code: "Comma" }), { kind: "speed", step: -1 });
    assert.deepEqual(press("<", { code: "IntlBackslash" }), { kind: "speed", step: -1 }, "a European keyboard's own < key");
    assert.equal(press(">", { singleKeys: false }), null);
    assert.equal(press(">", { target: { editable: true, player: false, control: false } }), null);
    assert.deepEqual(press(">", { repeat: true }), { kind: "speed", step: 1 }, "a held key keeps stepping");
    assert.deepEqual(press("<", { ctrlKey: true, altKey: true, altGraph: true, code: "Comma" }), { kind: "speed", step: -1 }, "Czech AltGr+,");
    assert.equal(press("<", { ctrlKey: true, altKey: true, altGraph: true, singleKeys: false }), null);
    assert.equal(press("л", { ctrlKey: true, altKey: true, altGraph: true, code: "KeyK" }), null, "AltGr answers only < and >");
    assert.equal(press("<", { ctrlKey: true }), null, "Ctrl without AltGr is the browser's");
    assert.deepEqual(press("Б", { shiftKey: true, code: "Comma" }), { kind: "speed", step: -1 }, "Russian Shift+, types Б");
    assert.deepEqual(press("Ю", { shiftKey: true, code: "Period" }), { kind: "speed", step: 1 });
    assert.equal(press("б", { code: "Comma" }), null, "unshifted, it is no shortcut");
    assert.equal(press(";", { shiftKey: true, code: "Comma" }), null, "a Latin character there is that character");
  });

  it("steps through the speeds offered, staying at the ends", () => {
    assert.equal(stepSpeed(1, 1), 1.25);
    assert.equal(stepSpeed(1, -1), 0.75);
    assert.equal(stepSpeed(2, 1), 2);
    assert.equal(stepSpeed(0.5, -1), 0.5);
    assert.equal(stepSpeed(1.1, 1), 1.25, "from between two, the next one that way");
    assert.equal(stepSpeed(1.1, -1), 1);
    assert.equal(stepSpeed(Number.NaN, 1), 1.25);
    assert.equal(stepSpeed(3, -1), 2);
  });

  it("names a speed, and keeps only a speed it offers", () => {
    assert.deepEqual(PLAYER_SPEEDS.map(speedLabel), ["0.5×", "0.75×", "Normal", "1.25×", "1.5×", "1.75×", "2×"]);
    assert.equal(storedSpeed("1.5"), 1.5);
    assert.equal(storedSpeed("1"), 1);
    for (const bad of [null, "", "abc", "16", "0", "-1", "1.3"]) assert.equal(storedSpeed(bad), null, String(bad));
  });
});
