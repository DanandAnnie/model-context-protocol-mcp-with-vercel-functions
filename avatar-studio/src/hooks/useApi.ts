"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

/** Minimal fetch hook with manual refetch and optional polling. */
export function useApi<T>(path: string | null, opts: { pollMs?: number; pollWhile?: (data: T) => boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = useRef(true);

  const load = useCallback(async () => {
    if (!path) return;
    // A manual refetch while a poll is pending must not start a second polling chain.
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      const result = await api<T>(path);
      if (!active.current) return;
      setData(result);
      setError(null);
      if (opts.pollMs && (!opts.pollWhile || opts.pollWhile(result))) {
        timer.current = setTimeout(load, opts.pollMs);
      }
    } catch (err) {
      if (active.current) setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (active.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, opts.pollMs]);

  useEffect(() => {
    active.current = true;
    setLoading(!!path);
    load();
    return () => {
      active.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [load, path]);

  return { data, error, loading, refetch: load, setData };
}
