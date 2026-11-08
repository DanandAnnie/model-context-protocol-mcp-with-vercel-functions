"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Moves the focus once the next render is on the page. After an `await`, the elements a state change brings (new
 * previews, a message, a link) are committed later, and a frame callback can run before they exist; an effect runs
 * after the commit, so the element it asks for is there.
 */
export function useFocusAfterRender() {
  const target = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const el = target.current?.();
    target.current = null;
    el?.focus();
  }, [tick]);
  return useCallback((el: () => HTMLElement | null | undefined) => {
    target.current = el;
    setTick((t) => t + 1);
  }, []);
}
