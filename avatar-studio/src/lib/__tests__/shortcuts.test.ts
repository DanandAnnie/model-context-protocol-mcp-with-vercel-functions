// The keyboard shortcuts dialog: the keys that open it and the list it shows.
// Run with: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isShortcutsKey, isSubmitKey, shortcutGroups } from "../shortcuts";

const press = (over: Partial<Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">>) => ({ key: "/", code: "Slash", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

describe("keyboard shortcuts", () => {
  it("opens on Ctrl+/ elsewhere and ⌘/ on a Mac, not the other way round", () => {
    assert.equal(isShortcutsKey(press({ ctrlKey: true }), false), true);
    assert.equal(isShortcutsKey(press({ metaKey: true }), true), true);
    assert.equal(isShortcutsKey(press({ metaKey: true }), false), false);
    assert.equal(isShortcutsKey(press({ ctrlKey: true }), true), false);
    assert.equal(isShortcutsKey(press({}), false), false);
    assert.equal(isShortcutsKey(press({ ctrlKey: true, altKey: true }), false), false);
  });

  it("finds / wherever the layout puts it", () => {
    // A German keyboard's / is Shift+7; the character is what counts.
    assert.equal(isShortcutsKey(press({ ctrlKey: true, shiftKey: true, code: "Digit7" }), false), true);
    // The key's place on a US layout counts only when it types no Latin character (a Cyrillic layout's ".").
    assert.equal(isShortcutsKey(press({ ctrlKey: true, key: "." }), false), false);
    assert.equal(isShortcutsKey(press({ ctrlKey: true, key: "ю" }), false), true);
    // There German, Spanish, and Nordic keyboards have "-" and Belgian "=": Ctrl+- and Ctrl+= zoom, left to the browser.
    assert.equal(isShortcutsKey(press({ ctrlKey: true, key: "-" }), false), false);
    assert.equal(isShortcutsKey(press({ ctrlKey: true, key: "=" }), false), false);
    // Shift with the US place is ? and not this shortcut.
    assert.equal(isShortcutsKey(press({ ctrlKey: true, shiftKey: true, key: "?" }), false), false);
  });

  it("posts a comment on Ctrl+Enter, ⌘Enter on a Mac, and on nothing else", () => {
    const enter = (over: Partial<KeyboardEvent>) => ({ key: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 13, ...over });
    assert.equal(isSubmitKey(enter({ ctrlKey: true }), false), true);
    assert.equal(isSubmitKey(enter({ metaKey: true }), true), true);
    assert.equal(isSubmitKey(enter({ metaKey: true }), false), false);
    assert.equal(isSubmitKey(enter({ ctrlKey: true }), true), false);
    // A plain Enter is a new line in the box.
    assert.equal(isSubmitKey(enter({}), false), false);
    assert.equal(isSubmitKey(enter({ ctrlKey: true, shiftKey: true }), false), false);
    assert.equal(isSubmitKey(enter({ ctrlKey: true, altKey: true }), false), false);
    assert.equal(isSubmitKey(enter({ ctrlKey: true, key: "m" }), false), false);
    // Held down it would post again once the box clears; ending an input method's text is not posting.
    assert.equal(isSubmitKey(enter({ ctrlKey: true, repeat: true }), false), false);
    assert.equal(isSubmitKey(enter({ ctrlKey: true, isComposing: true }), false), false);
    assert.equal(isSubmitKey(enter({ ctrlKey: true, keyCode: 229 }), false), false);
    const listed = shortcutGroups(true).find((g) => g.title === "In a video's comments")!.shortcuts;
    assert.deepEqual(listed[0].keys, [["⌘", "Enter"]]);
    assert.deepEqual(shortcutGroups(false).find((g) => g.title === "In a video's comments")!.shortcuts[0].keys, [["Ctrl", "Enter"]]);
  });

  it("lists the keys as each computer has them", () => {
    const mac = shortcutGroups(true).flatMap((g) => g.shortcuts);
    const pc = shortcutGroups(false).flatMap((g) => g.shortcuts);
    assert.deepEqual(mac.find((s) => s.does.startsWith("Quick find"))!.keys, [["⌘", "K"]]);
    assert.deepEqual(pc.find((s) => s.does.startsWith("Quick find"))!.keys, [["Ctrl", "K"]]);
    // Ctrl+Y redoes only off a Mac, where ⌘Y is the browser's history.
    assert.deepEqual(mac.find((s) => s.does === "Redo it")!.keys, [["⌘", "⇧", "Z"]]);
    assert.deepEqual(pc.find((s) => s.does === "Redo it")!.keys, [["Ctrl", "Shift", "Z"], ["Ctrl", "Y"]]);
    // Quick find's first and last result take Ctrl on a Mac too, as its handler does.
    assert.deepEqual(mac.find((s) => s.does === "Go to the first or last result")!.keys, [["Ctrl", "Home"], ["Ctrl", "End"]]);
    // The scene row's keys are the same on every computer.
    for (const list of [mac, pc]) {
      assert.deepEqual(list.find((s) => s.does.startsWith("Go to the scene before or after"))!.keys, [["←"], ["→"]]);
      assert.deepEqual(list.find((s) => s.does.startsWith("Go to the first or last scene"))!.keys, [["Home"], ["End"]]);
    }
  });
});
