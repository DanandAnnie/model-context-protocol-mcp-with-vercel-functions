import { useEffect, useRef, useCallback } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'

/**
 * Combined realtime subscription + visibility refetch + periodic polling.
 *
 * iOS Safari aggressively kills WebSocket connections when the PWA is backgrounded.
 * The Supabase channel object stays in a "subscribed" state but never receives events.
 * This hook:
 *  1. Subscribes to Supabase Realtime for instant sync
 *  2. Tears down and re-creates the channel when the app returns from background
 *  3. Polls every 30s as a safety net for missed realtime events
 *  4. Refetches on network reconnection
 */
export function useRealtimeSync(
  table: string,
  channelName: string,
  refetch: () => void,
) {
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  const channelRef = useRef<RealtimeChannel | null>(null)

  const subscribe = useCallback(() => {
    if (!isSupabaseConfigured()) return

    // Tear down stale channel first
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }

    channelRef.current = supabase
      .channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        refetchRef.current()
      })
      .subscribe()
  }, [table, channelName])

  // Initial subscription
  useEffect(() => {
    subscribe()
    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
        channelRef.current = null
      }
    }
  }, [subscribe])

  // Visibility change: re-subscribe + refetch when app comes back
  useEffect(() => {
    if (!isSupabaseConfigured()) return

    let lastHidden = 0

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        lastHidden = Date.now()
      }
      if (document.visibilityState === 'visible') {
        const elapsed = Date.now() - lastHidden
        if (elapsed > 3000 || lastHidden === 0) {
          // Re-create the channel — the old WebSocket is likely dead on iOS
          subscribe()
          refetchRef.current()
        }
      }
    }

    const onOnline = () => {
      subscribe()
      refetchRef.current()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [subscribe])

  // Periodic polling fallback — catch anything realtime missed
  useEffect(() => {
    if (!isSupabaseConfigured()) return

    const interval = setInterval(() => {
      // Only poll when the app is visible
      if (document.visibilityState === 'visible') {
        refetchRef.current()
      }
    }, 30_000) // every 30 seconds

    return () => clearInterval(interval)
  }, [])
}
