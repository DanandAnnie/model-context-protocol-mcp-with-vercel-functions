// On-screen text's length limit as the editor keeps it: counted as stored (the characters a reader sees once the
// spaces are collapsed), and enforced on an edit by cutting only what was typed or pasted.
import { graphemes } from "./text";
import { MAX_SCENE_TEXT } from "./types";

/** On-screen text's length as stored: the characters a reader sees once the spaces are collapsed. */
export const sceneTextLength = (raw: string) => graphemes(raw.replace(/\s+/g, " ").trim()).length;
/** On-screen text cut to its limit (text from a draft or template another build saved); text within it is kept as typed. */
export function capSceneText(raw: string): string {
  return sceneTextLength(raw) <= MAX_SCENE_TEXT ? raw : graphemes(raw.replace(/\s+/g, " ").trim()).slice(0, MAX_SCENE_TEXT).join("");
}
/**
 * An edit to on-screen text kept within the limit: when `next` is too long, only what was typed or pasted is cut (the
 * text around it stays), and the caret position after it is returned.
 */
export function fitSceneTextEdit(prev: string, next: string): { text: string; caret: number } | null {
  if (sceneTextLength(next) <= MAX_SCENE_TEXT) return null;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let end = 0;
  while (end < prev.length - start && end < next.length - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
  // Never between the two halves of an emoji's code point.
  const high = (c: string | undefined) => !!c && c >= "\uD800" && c <= "\uDBFF";
  if (start > 0 && high(next[start - 1])) start--;
  if (end > 0 && high(next[next.length - end - 1])) end--;
  const head = next.slice(0, start);
  const tail = next.slice(next.length - end);
  const inserted = graphemes(next.slice(start, next.length - end));
  // The most of the inserted text that still fits, whole characters only.
  let keep = inserted.length;
  while (keep > 0 && sceneTextLength(head + inserted.slice(0, keep).join("") + tail) > MAX_SCENE_TEXT) keep--;
  const added = inserted.slice(0, keep).join("");
  return { text: head + added + tail, caret: head.length + added.length };
}
