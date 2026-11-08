// While selecting in the library, Escape closes the bar's open field or else stops selecting, and Ctrl+A (⌘A on a
// Mac) selects every video shown; neither takes a key a text box needs.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSearchKey, libraryKey, shortcutGroups, singleKeyShortcutsOn, typesText } from "../shortcuts";

type Extra = Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing", boolean>> & { code?: string; keyCode?: number };
const key = (k: string, extra: Extra = {}) => ({
  key: k,
  code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  keyCode: 0,
  ...extra,
});
const base = { apple: false, selecting: true, busy: false, fieldOpen: false, inField: false, editable: false, inSelect: false };

describe("libraryKey", () => {
  it("does nothing unless selecting, or while an action runs", () => {
    assert.equal(libraryKey(key("Escape"), { ...base, selecting: false }), null);
    assert.equal(libraryKey(key("a", { ctrlKey: true }), { ...base, selecting: false }), null);
    assert.equal(libraryKey(key("Escape"), { ...base, busy: true }), null);
    assert.equal(libraryKey(key("a", { ctrlKey: true }), { ...base, busy: true }), null);
  });

  it("closes the open field first, from inside it or from the page, and then stops selecting", () => {
    assert.equal(libraryKey(key("Escape"), { ...base, fieldOpen: true, inField: true, editable: true }), "close-field");
    assert.equal(libraryKey(key("Escape"), { ...base, fieldOpen: true }), "close-field");
    assert.equal(libraryKey(key("Escape"), base), "stop");
  });

  it("leaves Escape to another text box, such as the search", () => {
    assert.equal(libraryKey(key("Escape"), { ...base, editable: true }), null);
    assert.equal(libraryKey(key("Escape"), { ...base, fieldOpen: true, editable: true }), null);
  });

  it("leaves an input method's Escape, a select's, and a held key's repeats alone", () => {
    const typing = { ...base, fieldOpen: true, inField: true, editable: true };
    assert.equal(libraryKey(key("Escape", { isComposing: true }), typing), null);
    assert.equal(libraryKey(key("Process", { keyCode: 229 }), typing), null);
    assert.equal(libraryKey(key("Escape", { keyCode: 229 }), typing), null);
    assert.equal(libraryKey(key("Escape"), { ...typing, inSelect: true }), null);
    assert.equal(libraryKey(key("Escape", { repeat: true }), { ...base, fieldOpen: true }), null);
    assert.equal(libraryKey(key("Escape", { repeat: true }), base), null);
    assert.equal(libraryKey(key("a", { ctrlKey: true, isComposing: true }), base), null);
  });

  it("takes Escape only on its own", () => {
    assert.equal(libraryKey(key("Escape", { shiftKey: true }), base), null);
    assert.equal(libraryKey(key("Escape", { ctrlKey: true }), base), null);
  });

  it("selects all on Ctrl+A off a Mac and ⌘A on one, in either case, but not in a text box", () => {
    assert.equal(libraryKey(key("a", { ctrlKey: true }), base), "select-all");
    assert.equal(libraryKey(key("A", { ctrlKey: true }), base), "select-all");
    assert.equal(libraryKey(key("a", { metaKey: true }), base), null);
    assert.equal(libraryKey(key("a", { metaKey: true }), { ...base, apple: true }), "select-all");
    assert.equal(libraryKey(key("a", { ctrlKey: true }), { ...base, apple: true }), null);
    assert.equal(libraryKey(key("a", { ctrlKey: true, shiftKey: true }), base), null);
    assert.equal(libraryKey(key("a", { ctrlKey: true, altKey: true }), base), null);
    assert.equal(libraryKey(key("a", { ctrlKey: true }), { ...base, editable: true }), null);
    assert.equal(libraryKey(key("a"), base), null);
  });

  it("finds the A key by its place on a layout that types no Latin letter, but not another layout's letter there", () => {
    assert.equal(libraryKey(key("ф", { ctrlKey: true, code: "KeyA" }), base), "select-all");
    assert.equal(libraryKey(key("α", { ctrlKey: true, code: "KeyA" }), base), "select-all");
    // AZERTY's Q sits where a US A is; Ctrl+Q there stays the browser's.
    assert.equal(libraryKey(key("q", { ctrlKey: true, code: "KeyA" }), base), null);
    // AZERTY's A sits where a US Q is, and is found by its character.
    assert.equal(libraryKey(key("a", { ctrlKey: true, code: "KeyQ" }), base), "select-all");
  });

  it("is listed in the keyboard shortcuts with this computer's keys", () => {
    for (const [apple, mod] of [[false, "Ctrl"], [true, "⌘"]] as const) {
      const group = shortcutGroups(apple).find((g) => g.title === "In My videos, while selecting")!;
      assert.deepEqual(group.shortcuts.map((s) => s.keys), [
        [[apple ? "⇧" : "Shift", "Click"], [apple ? "⇧" : "Shift", "Space"]],
        [[mod, "A"]],
        [["Esc"]],
      ]);
    }
  });
});

describe("isSearchKey", () => {
  const on = { editable: false, enabled: true };
  it("is \"/\" where it would not be typed, however the layout types it", () => {
    assert.equal(isSearchKey(key("/", { code: "Slash" }), on), true);
    assert.equal(isSearchKey(key("/", { code: "Digit7", shiftKey: true }), on), true, "Shift does not refuse it (Shift+7 on a German keyboard)");
    assert.equal(isSearchKey(key("/", { code: "NumpadDivide" }), on), true, "the number pad's / too");
    const altGr = { ...key("/", { code: "KeyQ", ctrlKey: true, altKey: true }), getModifierState: (k: string) => k === "AltGraph" };
    assert.equal(isSearchKey(altGr, on), true, "AltGr+Q on a Brazilian keyboard, which reports Ctrl and Alt");
  });

  it("leaves \"/\" to text, to a key press with Ctrl, ⌘, or Alt, and to a reader who turned single keys off", () => {
    assert.equal(isSearchKey(key("/"), { editable: true, enabled: true }), false);
    for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { ctrlKey: true, altKey: true }]) assert.equal(isSearchKey(key("/", extra), on), false, JSON.stringify(extra));
    assert.equal(isSearchKey(key("/"), { editable: false, enabled: false }), false);
  });

  it("is no other character, nor a held or composing one", () => {
    for (const k of ["?", "s", "\\", "÷"]) assert.equal(isSearchKey(key(k), on), false, k);
    assert.equal(isSearchKey(key("/", { repeat: true }), on), false);
    assert.equal(isSearchKey(key("/", { isComposing: true }), on), false);
    assert.equal(isSearchKey(key("/", { keyCode: 229 }), on), false);
  });

  it("is listed in the Keyboard shortcuts dialog", () => {
    const group = shortcutGroups(false).find((g) => g.title === "In My videos")!;
    assert.deepEqual(group.shortcuts.map((s) => s.keys), [[["/"]]]);
  });
});

describe("single-key shortcuts", () => {
  it("are on unless this browser was told to turn them off", () => {
    assert.equal(singleKeyShortcutsOn(null), true);
    assert.equal(singleKeyShortcutsOn("off"), false);
    assert.equal(singleKeyShortcutsOn("on"), true);
  });

  it("are not taken where a key press goes into text", () => {
    assert.equal(typesText(null), false);
    for (const type of ["text", "search", "email", "url", "number", "password", "datetime-local", "TEXT"]) assert.equal(typesText({ tagName: "INPUT", type }), true, type);
    assert.equal(typesText({ tagName: "INPUT" }), true, "an input with no type is text");
    for (const type of ["checkbox", "radio", "button", "submit", "file", "range", "color"]) assert.equal(typesText({ tagName: "INPUT", type }), false, type);
    assert.equal(typesText({ tagName: "TEXTAREA" }), true);
    assert.equal(typesText({ tagName: "SELECT" }), true, "a list box types to choose");
    assert.equal(typesText({ tagName: "DIV", isContentEditable: true }), true);
    for (const tagName of ["A", "BUTTON", "DIV", "BODY"]) assert.equal(typesText({ tagName }), false, tagName);
  });
});
