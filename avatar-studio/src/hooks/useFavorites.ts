"use client";
import { useCallback, useMemo, useRef } from "react";
import { useApi } from "@/hooks/useApi";
import { useCanEdit } from "@/hooks/useCanEdit";
import { api } from "@/lib/client";
import type { Prefs } from "@/lib/types";

export type FavoriteKind = "avatar" | "voice";

/**
 * Starred avatars and voices, with an optimistic toggle that reverts if the save fails. Stars are
 * the workspace's, so `canToggle` is false for a viewer (the server answers 403 for them too).
 */
export function useFavorites() {
  const { data, setData } = useApi<{ prefs: Prefs | null }>("/api/prefs");
  const canToggle = useCanEdit() === true;
  const avatarIds = useMemo(() => new Set(data?.prefs?.favoriteAvatarIds ?? []), [data]);
  const voiceIds = useMemo(() => new Set(data?.prefs?.favoriteVoiceIds ?? []), [data]);
  // Saves run one after another: the server rewrites the whole preferences record, so two
  // overlapping requests would let the later one drop the earlier star.
  const queue = useRef<Promise<void>>(Promise.resolve());

  const toggle = useCallback(
    (kind: FavoriteKind, id: string) => {
      if (data === null) return; // stars render only once the list is known; a click before that would race the first load
      const field = kind === "avatar" ? "favoriteAvatarIds" : "favoriteVoiceIds";
      const before = data.prefs;
      const current = before?.[field] ?? [];
      const on = !current.includes(id);
      const optimistic = on ? [...current, id] : current.filter((x) => x !== id);
      setData((d) => ({ ...(d ?? {}), prefs: { ...(d?.prefs ?? ({} as Prefs)), [field]: optimistic } as Prefs }));
      queue.current = queue.current.then(async () => {
        try {
          const { prefs } = await api<{ prefs: Prefs }>("/api/prefs/favorites", { method: "POST", body: JSON.stringify({ kind, id, on }) });
          setData((d) => ({ ...(d ?? {}), prefs }));
        } catch {
          setData((d) => ({ ...(d ?? {}), prefs: before ?? null }));
        }
      });
    },
    [data, setData],
  );

  return { avatarIds, voiceIds, toggle, canToggle, loaded: data !== null };
}

/** The items whose id is starred, in their own order, ahead of the rest. */
export function favoritesFirst<T extends { id: string }>(items: T[], starred: Set<string>): T[] {
  if (starred.size === 0) return items;
  return [...items.filter((i) => starred.has(i.id)), ...items.filter((i) => !starred.has(i.id))];
}
