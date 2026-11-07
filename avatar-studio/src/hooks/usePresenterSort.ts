"use client";
import { useEffect, useState } from "react";
import { parsePresenterSort, type PresenterSort } from "@/lib/client";

/**
 * The Avatars or Voices page's sort, remembered in this browser under `key` (as the library remembers its layout).
 * Until the stored choice is read, and wherever storage is blocked, it is the default order.
 */
export function usePresenterSort(key: string): [PresenterSort, (next: PresenterSort) => void] {
  const [sort, setSort] = useState<PresenterSort>("default");
  useEffect(() => {
    try {
      setSort(parsePresenterSort(window.localStorage.getItem(key)));
    } catch {
      // Storage blocked (a private window, say): the default order it is.
    }
  }, [key]);
  const choose = (next: PresenterSort) => {
    setSort(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // Not remembered, but the choice still holds for this visit.
    }
  };
  return [sort, choose];
}
