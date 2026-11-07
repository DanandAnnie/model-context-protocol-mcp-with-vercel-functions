"use client";

// Where captions sit, how big they read, their look, and their typeface: the editor's caption style, and the brand
// kit's default one.
import { CAPTION_FONT_STACKS, captionStyleWithoutDefaults } from "@/lib/caption-style";
import { CAPTION_FONTS, CAPTION_LOOKS, CAPTION_POSITIONS, CAPTION_SIZES, type CaptionStyle } from "@/lib/types";

const choice = (on: boolean) =>
  `flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium capitalize ${on ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`;

export function CaptionStyleFields({ value, onChange }: { value: CaptionStyle; onChange: (style: CaptionStyle) => void }) {
  const set = (patch: Partial<CaptionStyle>) => onChange(captionStyleWithoutDefaults({ ...value, ...patch }));
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      <div role="group" aria-label="Caption position" className="flex gap-1">
        {CAPTION_POSITIONS.map((position) => (
          <button key={position} type="button" aria-pressed={value.position === position} onClick={() => set({ position })} className={choice(value.position === position)}>
            {position}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Caption size" className="flex gap-1">
        {CAPTION_SIZES.map((size) => (
          <button key={size} type="button" aria-pressed={value.size === size} onClick={() => set({ size })} className={choice(value.size === size)}>
            {size}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Caption look" className="flex gap-1 sm:col-span-2">
        {CAPTION_LOOKS.map((look) => {
          const on = (value.look ?? "classic") === look;
          return (
            <button key={look} type="button" aria-pressed={on} onClick={() => set({ look })} className={choice(on)}>
              {look}
            </button>
          );
        })}
      </div>
      <div role="group" aria-label="Caption font" className="flex gap-1 sm:col-span-2">
        {CAPTION_FONTS.map((font) => {
          const on = (value.font ?? "sans") === font;
          return (
            <button key={font} type="button" aria-pressed={on} onClick={() => set({ font })} style={{ fontFamily: CAPTION_FONT_STACKS[font] }} className={choice(on)}>
              {font}
            </button>
          );
        })}
      </div>
    </div>
  );
}
