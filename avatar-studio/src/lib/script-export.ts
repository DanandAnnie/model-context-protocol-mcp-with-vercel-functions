// A video's script as a plain-text file, which the editor's script import reads back scene for scene. Pure, so the
// editor and the tests share it.
import { safeFileStem } from "./attachment";
import { BREAK } from "./script-import";

/**
 * The scenes' words as plain text, the scenes apart on `---` lines, where the import starts a new scene (pause
 * markers kept, scenes without words left out). A line of a scene's own that the import would take for a break
 * (`***`, `---`) is indented past what it reads as one, and the import trims it back. A lone scene ends with a
 * `---` too, so the import keeps its paragraphs together as one scene rather than making a scene of each. A byte
 * order mark opens the file, so older Windows editors read it as UTF-8. Empty when no scene has words.
 */
export function scriptFile(scripts: string[]): string {
  const parts = scripts
    .map((s) => s.replace(/\r\n?/g, "\n").trim())
    .filter(Boolean)
    .map((s) => s.split("\n").map((line) => (BREAK.test(line) ? `    ${line.trim()}` : line)).join("\n"));
  if (!parts.length) return "";
  return "\uFEFF" + parts.join("\n\n---\n\n") + (parts.length === 1 ? "\n\n---\n" : "\n");
}

/** A file name for the script from the video's title, made safe to save under, with `.txt` added once. */
export function scriptFileName(title: string): string {
  return `${safeFileStem(title, ["txt"]) || "Script"}.txt`;
}
