"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

/** Minimal fetch hook with manual refetch and optional polling. */
export function useApi<T>(path: string | null, opts: { pollMs?: number; pollWhile?: (data: T) => boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Every request takes a ticket; only the latest ticket may publish its result or schedule
  // the next poll. A slow response for an earlier path (or an earlier refetch) is dropped, so
  // it can neither overwrite newer data nor restart polling on a URL the page has left.
  const ticket = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++ticket.current;
    // A manual refetch while a poll is pending must not start a second polling chain.
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      const result = await api<T>(path);
      if (mine !== ticket.current) return;
      setData(result);
      setError(null);
      if (opts.pollMs && (!opts.pollWhile || opts.pollWhile(result))) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(load, opts.pollMs);
      }
    } catch (err) {
      if (mine === ticket.current) setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, opts.pollMs]);

  useEffect(() => {
    setLoading(!!path);
    load();
    return () => {
      // Leaving this path (or unmounting) retires every request issued for it.
      ticket.current += 1;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [load, path]);

  return { data, error, loading, refetch: load, setData };
}
