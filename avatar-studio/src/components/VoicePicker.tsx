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
  const meta = [voice.language, voice.gender, ...(voice.tags ?? [])].filter(Boolean).slice(0, 4).join(" · ") || voice.provider;
  const nameBlock = (
    <>
      <div className="truncate text-sm font-medium text-slate-900">{voice.name}</div>
      <div className="truncate text-xs text-slate-500">{meta}</div>
    </>
  );
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition ${
        selected ? "border-brand-500 bg-brand-50" : "border-slate-200 bg-white hover:border-slate-300"
      }`}
      aria-current={selected ? "true" : undefined}
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
      {onSelect ? (
        // The whole name block selects the voice; preview and star stay siblings so no control nests in another.
        <button type="button" onClick={onSelect} aria-pressed={!!selected} className="min-w-0 flex-1 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300">
          {nameBlock}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{nameBlock}</div>
      )}
      {onToggleFavorite && <FavoriteStar name={voice.name} on={!!favorite} onToggle={onToggleFavorite} className="shrink-0 shadow-none" />}
    </div>
  );
}
