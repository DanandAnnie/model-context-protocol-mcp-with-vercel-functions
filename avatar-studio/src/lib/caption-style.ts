// Caption styles as the editor, the brand kit, and their hand-offs keep them. Pure, so the pages and the tests share it.
import { CAPTION_FONTS, CAPTION_LOOKS, CAPTION_POSITIONS, CAPTION_SIZES, DEFAULT_CAPTION_STYLE, type CaptionFont, type CaptionStyle } from "./types";

/** The same stacks the share player's captions use (globals.css), so a preview shows the chosen typeface. */
export const CAPTION_FONT_STACKS: Record<CaptionFont, string> = {
  sans: "inherit",
  serif: 'Georgia, "Times New Roman", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

/** A caption style with the default look and font left out, as the server stores it. */
export const captionStyleWithoutDefaults = ({ look, font, ...rest }: CaptionStyle): CaptionStyle => ({
  ...rest,
  ...(look && look !== "classic" ? { look } : {}),
  ...(font && font !== "sans" ? { font } : {}),
});

/**
 * A caption style from a draft, a hand-off, or a brand kit another build saved: any value this build does not offer
 * falls back to the default. The default style for anything that is not one.
 */
export function restoredCaptionStyle(value: unknown): CaptionStyle {
  if (!value || typeof value !== "object") return DEFAULT_CAPTION_STYLE;
  const s = value as Partial<Record<keyof CaptionStyle, unknown>>;
  const pick = <T extends string>(list: readonly T[], v: unknown): T | undefined => (list as readonly unknown[]).includes(v) ? (v as T) : undefined;
  return captionStyleWithoutDefaults({
    position: pick(CAPTION_POSITIONS, s.position) ?? DEFAULT_CAPTION_STYLE.position,
    size: pick(CAPTION_SIZES, s.size) ?? DEFAULT_CAPTION_STYLE.size,
    look: pick(CAPTION_LOOKS, s.look),
    font: pick(CAPTION_FONTS, s.font),
  });
}
