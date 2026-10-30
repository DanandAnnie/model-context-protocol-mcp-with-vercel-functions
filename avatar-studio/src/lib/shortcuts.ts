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
        { keys: [[mod, "Z"]], does: "Undo a scene change (outside a text box, whose own undo takes back typing)" },
        { keys: apple ? [[mod, shift, "Z"]] : [[mod, shift, "Z"], [mod, "Y"]], does: "Redo it" },
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

