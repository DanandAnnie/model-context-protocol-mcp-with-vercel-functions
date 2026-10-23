"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

/** Minimal fetch hook with manual refetch and optional polling. */
export function useApi<T>(path: string | null, opts: { pollMs?: number; pollWhile?: (data: T) => boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const result = await api<T>(path);
      setData(result);
      setError(null);
      if (opts.pollMs && (!opts.pollWhile || opts.pollWhile(result))) {
        timer.current = setTimeout(load, opts.pollMs);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, opts.pollMs]);

  useEffect(() => {
    setLoading(!!path);
    load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, path]);

  return { data, error, loading, refetch: load, setData };
}
