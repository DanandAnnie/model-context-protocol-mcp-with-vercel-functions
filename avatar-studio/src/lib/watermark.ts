// Placement of the brand-logo watermark over the share player, as Tailwind classes.
import type { WatermarkCorner } from "./types";

/**
 * Where the logo sits, in shares of the frame so it keeps its place on a small embed. A bottom corner
 * clears the native controls (at least 2.75rem), and on a captioned video it rises above the caption
 * band, which runs about a fifth of the way up.
 */
export function watermarkPlace(corner: WatermarkCorner, captioned: boolean): string {
  // One object-position class per corner: two (say object-left and object-top) do not combine, the later rule wins.
  const at: Record<WatermarkCorner, string> = {
    "top-left": "left-[3%] top-[4%] object-[left_top]",
    "top-right": "right-[3%] top-[4%] object-[right_top]",
    "bottom-left": "left-[3%] object-[left_bottom]",
    "bottom-right": "right-[3%] object-[right_bottom]",
  };
  return corner.startsWith("top") ? at[corner] : `${at[corner]} ${captioned ? "bottom-[max(2.75rem,24%)]" : "bottom-[max(2.75rem,12%)]"}`;
}
