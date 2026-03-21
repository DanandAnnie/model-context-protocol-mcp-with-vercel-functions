import { useEffect, useRef } from 'react'

/**
 * Refetch data when the app becomes visible again (user returns from background).
 * Critical for iOS PWAs where Safari kills WebSocket connections in the background,
 * causing Supabase Realtime subscriptions to go stale.
 *
 * Also refetches on online events to catch network reconnections.
 */
export function useVisibilityRefetch(refetch: () => void, enabled = true) {
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  useEffect(() => {
    if (!enabled) return

    let lastHidden = 0

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        lastHidden = Date.now()
      }
      if (document.visibilityState === 'visible') {
        // Only refetch if the app was hidden for more than 5 seconds
        // to avoid unnecessary refetches during quick tab switches
        const elapsed = Date.now() - lastHidden
        if (elapsed > 5000 || lastHidden === 0) {
          refetchRef.current()
        }
      }
    }

    const onOnline = () => {
      refetchRef.current()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [enabled])
}
