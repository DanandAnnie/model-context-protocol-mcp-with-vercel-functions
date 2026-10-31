"use client";
import { Star } from "lucide-react";

/** Star toggle rendered beside (never inside) the control it marks, so no button nests in another. */
export function FavoriteStar({ name, on, onToggle, className = "" }: { name: string; on: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
      title={on ? "Remove from favourites" : "Add to favourites"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`rounded-full p-1.5 shadow transition ${on ? "bg-amber-400 text-white hover:bg-amber-500" : "bg-white/90 text-slate-500 hover:text-amber-500"} ${className}`}
    >
      <Star className="h-3.5 w-3.5" fill={on ? "currentColor" : "none"} />
    </button>
  );
}
