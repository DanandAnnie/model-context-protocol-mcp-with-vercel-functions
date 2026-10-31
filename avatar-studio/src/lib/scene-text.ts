// On-screen text as the editor keeps it: its length limit, counted as stored (the characters a reader sees once the
// spaces are collapsed) and enforced on an edit by cutting only what was typed or pasted; the colours offered for it;
// and its style (position, size, and colour) given to other scenes.
import { graphemes } from "./text";
import { MAX_SCENE_TEXT, type SceneText } from "./types";

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

export interface TextSwatch {
  label: string;
  /** `#rrggbb`, lower case. */
  color: string;
}
/**
 * The colours offered for on-screen text in one click: white (the default), then the brand kit's primary and accent
 * colours. A brand colour that repeats one before it (a white primary, an accent the same as the primary) is left out.
 */
export function textSwatches(kit: { primaryColor?: string; accentColor?: string } | null | undefined): TextSwatch[] {
  const out: TextSwatch[] = [{ label: "White", color: "#ffffff" }];
  const add = (label: string, raw: string | undefined) => {
    const color = raw?.toLowerCase();
    if (color && /^#[0-9a-f]{6}$/.test(color) && !out.some((s) => s.color === color)) out.push({ label, color });
  };
  add("Brand primary", kit?.primaryColor);
  add("Brand accent", kit?.accentColor);
  return out;
}

/** The WCAG contrast ratio of two `#rrggbb` colours, from 1 (the same) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Whether text in `color` would hardly show on a scene's plain colour `background` (contrast under 1.5:1). */
export const textHidden = (color: string, background: string) =>
  /^#[0-9a-f]{6}$/i.test(color) && /^#[0-9a-f]{6}$/i.test(background) && contrastRatio(color, background) < 1.5;

/** Whether two scenes' on-screen text shows the same way: position, size, and colour, an absent one being the default. */
export const sameTextStyle = (a: SceneText, b: SceneText) =>
  (a.position ?? "top") === (b.position ?? "top") &&
  (a.size ?? "medium") === (b.size ?? "medium") &&
  (a.color ?? "#ffffff").toLowerCase() === (b.color ?? "#ffffff").toLowerCase();
/** On-screen text with `style`'s position, size, and colour and its own words; a default is stored as absent. */
export function withTextStyle(overlay: SceneText, style: SceneText): SceneText {
  const color = style.color?.toLowerCase();
  return {
    text: overlay.text,
    ...(style.position && style.position !== "top" ? { position: style.position } : {}),
    ...(style.size && style.size !== "medium" ? { size: style.size } : {}),
    ...(color && color !== "#ffffff" ? { color } : {}),
  };
}
/** The other scenes whose on-screen text would take scene `from`'s style: those with words on screen shown another way. */
export function textStyleTargets(overlays: readonly (SceneText | undefined)[], from: number): number[] {
  const style = overlays[from];
  if (!style?.text.trim()) return [];
  return overlays.flatMap((o, i) => (i !== from && o?.text.trim() && !sameTextStyle(o, style) ? [i] : []));
}
