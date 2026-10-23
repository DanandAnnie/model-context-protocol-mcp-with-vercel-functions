"use client";
import { Check } from "lucide-react";
import { FavoriteStar } from "@/components/FavoriteStar";
import { portraitSvg } from "@/lib/stock";
import type { Avatar } from "@/lib/types";

export function AvatarTile({ avatar, selected, onSelect, compact }: { avatar: Avatar; selected?: boolean; onSelect?: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group relative block w-full overflow-hidden rounded-xl border bg-white text-left transition ${
        selected ? "border-brand-500 ring-2 ring-brand-200" : "border-slate-200 hover:border-slate-300"
      }`}
    >
      <div className={`${compact ? "aspect-[4/5]" : "aspect-[4/5]"} w-full overflow-hidden bg-slate-100`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatar.imageUrl}
          alt={avatar.name}
          className="h-full w-full object-cover transition group-hover:scale-[1.02]"
          loading="lazy"
          onError={(e) => {
            const img = e.currentTarget;
            if (!img.dataset.fallback) {
              img.dataset.fallback = "1";
              img.src = portraitSvg(avatar.name, avatar.name.length);
            }
          }}
        />
      </div>
      <div className="p-2.5">
        <div className="truncate text-sm font-medium text-slate-900">{avatar.name}</div>
        <div className="mt-0.5 truncate text-xs text-slate-500">
          {avatar.source === "custom" ? "My avatar" : avatar.source === "provider" ? avatar.provider : "Stock"}
          {avatar.tags?.length ? ` · ${avatar.tags.slice(0, 2).join(", ")}` : ""}
        </div>
      </div>
      {selected && (
        <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-white">
          <Check className="h-3.5 w-3.5" />
        </span>
      )}
    </button>
  );
}

export function AvatarGrid({
  avatars,
  selectedId,
  onSelect,
  compact,
  favoriteIds,
  onToggleFavorite,
}: {
  avatars: Avatar[];
  selectedId?: string;
  onSelect: (a: Avatar) => void;
  compact?: boolean;
  favoriteIds?: Set<string>;
  onToggleFavorite?: (a: Avatar) => void;
}) {
  return (
    <div className={`grid gap-3 ${compact ? "grid-cols-3 sm:grid-cols-4" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"}`} data-testid="avatar-grid">
      {avatars.map((a) => (
        <div key={a.id} className="relative">
          <AvatarTile avatar={a} selected={a.id === selectedId} onSelect={() => onSelect(a)} compact={compact} />
          {onToggleFavorite && <FavoriteStar name={a.name} on={!!favoriteIds?.has(a.id)} onToggle={() => onToggleFavorite(a)} className="absolute left-2 top-2" />}
        </div>
      ))}
    </div>
  );
}
