// The studio's keyboard shortcuts as the Keyboard shortcuts dialog lists them. Pure, so the dialog and the tests share it.

/**
 * Whether a key press is Ctrl+/ (⌘/ on a Mac): by the character on any layout that has one, and by the key's place on
 * a US keyboard only when the key types no Latin character (a Cyrillic or Greek layout). Elsewhere that place is
 * another key, such as German, Spanish, or Nordic "-", whose Ctrl+- zooms out and is left to the browser.
 */
export function isShortcutsKey(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, apple: boolean) {
  const modifier = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return modifier && !e.altKey && (e.key === "/" || (e.code === "Slash" && !e.shiftKey && !/^[\x20-\x7e]$/.test(e.key)));
}

export type Shortcut = { keys: string[][]; does: string };

/**
 * What a key press does in the library while selecting: Escape closes the field open in the bar (a folder, a time, the
 * password, or the link settings), or else ends selecting; Ctrl+A (⌘A on a Mac) selects every video shown. Neither
 * takes a key from a text box (outside the bar's own field, Escape is the box's), and nothing is done while not
 * selecting or while an action is running. An Escape that ends an input method's composition, closes a select's list,
 * or repeats from a held key is not for the bar, so a held key cannot run on from closing the field to clearing the
 * selection. Ctrl+A is the A key by character, or by its place on a layout whose key types no Latin letter (Cyrillic,
 * Greek), as Ctrl+/ is.
 */
export function libraryKey(
  e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "keyCode">,
  state: { apple: boolean; selecting: boolean; busy: boolean; fieldOpen: boolean; inField: boolean; editable: boolean; inSelect: boolean },
): "close-field" | "stop" | "select-all" | null {
  if (!state.selecting || state.busy || e.isComposing || e.keyCode === 229) return null;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (e.key === "Escape" && plain) {
    if (e.repeat || state.inSelect) return null;
    if (state.fieldOpen && (state.inField || !state.editable)) return "close-field";
    return state.editable ? null : "stop";
  }
  const modifier = state.apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const a = e.key.toLowerCase() === "a" || (e.code === "KeyA" && !/^[\x20-\x7e]$/.test(e.key));
  if (modifier && !e.altKey && !e.shiftKey && a && !state.editable) return "select-all";
  return null;
}

/** The studio's shortcuts, with the keys as this computer has them: each entry is one or more ways to press it. */
export function shortcutGroups(apple: boolean): Array<{ title: string; shortcuts: Shortcut[] }> {
  const mod = apple ? "⌘" : "Ctrl";
  const shift = apple ? "⇧" : "Shift";
  return [
    {
      title: "Anywhere in the studio",
      shortcuts: [
        { keys: [[mod, "K"]], does: "Quick find: go to a page, a video, or a template" },
        { keys: [[mod, "/"]], does: "Show these shortcuts" },
        { keys: [["Esc"]], does: "Close an open menu, panel, or form, such as the Improve menu, find and replace, the script writer, or the conversation box" },
        { keys: [["Enter"]], does: "Save a rename (Esc leaves the name as it was)" },
      ],
    },
    {
      title: "In the video editor",
      shortcuts: [
        { keys: [[mod, "Enter"]], does: "Generate the video, once it is ready to" },
        { keys: [["←"], ["→"]], does: "Go to the scene before or after (on a scene's number in the Scenes row)" },
        { keys: [["Home"], ["End"]], does: "Go to the first or last scene (on a scene's number in the Scenes row)" },
        { keys: [[mod, "Z"]], does: "Undo a scene change (outside a text box, whose own undo takes back typing)" },
        { keys: apple ? [[mod, shift, "Z"]] : [[mod, shift, "Z"], [mod, "Y"]], does: "Redo it" },
      ],
    },
    {
      title: "In My videos, while selecting",
      // A focused card's Space or Enter clicks it with the Shift key as held, so the keyboard picks a run the same way.
      shortcuts: [
        { keys: [[shift, "Click"], [shift, "Space"]], does: "Select, or unselect, a run of videos: every one from the video clicked last to the one Shift+clicked" },
        { keys: [[mod, "A"]], does: "Select every video shown (up to the 200 one action takes)" },
        { keys: [["Esc"]], does: "Close the field open in the bar, such as the folder or a time; with none open, stop selecting" },
      ],
    },
    {
      title: "In quick find",
      shortcuts: [
        { keys: [["↑"], ["↓"]], does: "Move through the results" },
        // Quick find takes Ctrl here on a Mac too, where ⌘ with an arrow moves through the box's text.
        { keys: [["Ctrl", "Home"], ["Ctrl", "End"]], does: "Go to the first or last result" },
        { keys: [["Enter"]], does: "Open the result" },
        { keys: [["Esc"]], does: "Close it, back where you were" },
      ],
    },
  ];
}

