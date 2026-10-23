"use client";
import { Loader2, Pause, Play } from "lucide-react";
import { FavoriteStar } from "@/components/FavoriteStar";
import type { Voice } from "@/lib/types";

export function VoiceRow({
  voice,
  selected,
  onSelect,
  onPreview,
  playing,
  busy,
  favorite,
  onToggleFavorite,
}: {
  voice: Voice;
  selected?: boolean;
  onSelect?: () => void;
  onPreview: () => void;
  playing: boolean;
  busy: boolean;
  favorite?: boolean;
  onToggleFavorite?: () => void;
}) {
  return (
    <div
      role={onSelect ? "button" : undefined}
      onClick={onSelect}
      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition ${
        selected ? "border-brand-500 bg-brand-50" : "border-slate-200 bg-white hover:border-slate-300"
      } ${onSelect ? "cursor-pointer" : ""}`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onPreview();
        }}
        aria-label={playing ? "Stop preview" : "Play preview"}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white hover:bg-slate-700"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-900">{voice.name}</div>
        <div className="truncate text-xs text-slate-500">
          {[voice.language, voice.gender, ...(voice.tags ?? [])].filter(Boolean).slice(0, 4).join(" · ") || voice.provider}
        </div>
      </div>
      {onToggleFavorite && <FavoriteStar name={voice.name} on={!!favorite} onToggle={onToggleFavorite} className="shrink-0 shadow-none" />}
    </div>
  );
}
