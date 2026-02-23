import { useState, useEffect, useCallback } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { cacheData, getCachedData } from '../lib/offline'
import { scanDealsClientSide } from '../lib/deal-scanner'
import type { Deal, DealInsert, DealWatch, DealWatchInsert } from '../lib/database.types'

const SCAN_API_URL = '/api/scan-deals'
const SCAN_INTERVAL_KEY = 'deals_scan_interval_ms'
const DEFAULT_SCAN_INTERVAL = 4 * 60 * 60 * 1000 // 4 hours

export function useDeals() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [watches, setWatches] = useState<DealWatch[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [lastScanAt, setLastScanAt] = useState<string | null>(
    localStorage.getItem('deals_last_scan'),
  )

  // Load deals from cache/Supabase
  const fetchDeals = useCallback(async () => {
    setLoading(true)

    if (!isSupabaseConfigured()) {
      const cachedDeals = await getCachedData('deals')
      const cachedWatches = await getCachedData('deal_watches')
      setDeals(cachedDeals.sort((a, b) => b.found_at.localeCompare(a.found_at)))
      setWatches(cachedWatches)
      setLoading(false)
      return
    }

    try {
      const [dealsRes, watchesRes] = await Promise.all([
        supabase.from('deals').select('*').order('found_at', { ascending: false }).limit(200),
        supabase.from('deal_watches').select('*').order('created_at', { ascending: false }),
      ])

      if (dealsRes.data) {
        setDeals(dealsRes.data)
        await cacheData('deals', dealsRes.data)
      }
      if (watchesRes.data) {
        setWatches(watchesRes.data)
        await cacheData('deal_watches', watchesRes.data)
      }
    } catch {
      const cachedDeals = await getCachedData('deals')
      const cachedWatches = await getCachedData('deal_watches')
      setDeals(cachedDeals)
      setWatches(cachedWatches)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchDeals() }, [fetchDeals])

  // Add a watch
  const addWatch = async (watch: DealWatchInsert) => {
    const newWatch: DealWatch = {
      ...watch,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    if (!isSupabaseConfigured()) {
      const allCached = await getCachedData('deal_watches')
      await cacheData('deal_watches', [...allCached, newWatch])
      setWatches((prev) => [...prev, newWatch])
      return newWatch
    }

    const { data, error } = await supabase.from('deal_watches').insert(watch).select().single()
    if (error) throw error
    await fetchDeals()
    return data
  }

  // Update a watch
  const updateWatch = async (id: string, updates: Partial<DealWatchInsert>) => {
    if (!isSupabaseConfigured()) {
      const allCached = await getCachedData('deal_watches')
      const updated = allCached.map((w) =>
        w.id === id ? { ...w, ...updates, updated_at: new Date().toISOString() } : w,
      )
      await cacheData('deal_watches', updated)
      setWatches((prev) =>
        prev.map((w) => (w.id === id ? { ...w, ...updates, updated_at: new Date().toISOString() } : w)),
      )
      return
    }

    const { error } = await supabase.from('deal_watches').update(updates).eq('id', id)
    if (error) throw error
    await fetchDeals()
  }

  // Delete a watch
  const deleteWatch = async (id: string) => {
    if (!isSupabaseConfigured()) {
      const allCached = await getCachedData('deal_watches')
      await cacheData('deal_watches', allCached.filter((w) => w.id !== id))
      setWatches((prev) => prev.filter((w) => w.id !== id))
      return
    }

    const { error } = await supabase.from('deal_watches').delete().eq('id', id)
    if (error) throw error
    await fetchDeals()
  }

  // Fetch deals from sources — try API first, fall back to client-side scanning
  const fetchFromSources = async (watchCriteria: { keywords: string; category: string; max_price: number; min_discount: number }[]) => {
    // Try the Vercel API route first
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      const resp = await fetch(SCAN_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watches: watchCriteria }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (resp.ok) {
        const data = await resp.json()
        if (data && Array.isArray(data.deals)) return data
      }
    } catch { /* API unavailable, fall through to client-side */ }

    // Fall back to client-side scanning (works everywhere, no server needed)
    try {
      return await scanDealsClientSide(watchCriteria)
    } catch { /* client-side also failed */ }

    // Everything failed — return empty result instead of throwing
    return { deals: [], scanned_at: new Date().toISOString(), sources_checked: [] }
  }

  // Scan for new deals
  const scanDeals = async () => {
    setScanning(true)
    try {
      const watchCriteria = watches
        .filter((w) => w.active)
        .map((w) => ({
          keywords: w.keywords,
          category: w.category,
          max_price: w.max_price,
          min_discount: w.min_discount,
        }))

      const result = await fetchFromSources(watchCriteria)
      const newDeals = Array.isArray(result?.deals) ? result.deals : []
      const scanned_at = result?.scanned_at || new Date().toISOString()

      // Process results
      const existingUrls = new Set(deals.map((d) => d.source_url))
      const freshDeals: Deal[] = []

      for (const raw of newDeals) {
        if (!raw?.source_url || existingUrls.has(raw.source_url)) continue

        const deal: Deal = {
          id: crypto.randomUUID(),
          title: raw.title || '',
          description: raw.description || '',
          source: raw.source || 'other',
          source_url: raw.source_url,
          image_url: raw.image_url || '',
          original_price: raw.original_price || 0,
          sale_price: raw.sale_price || 0,
          discount_percent: raw.discount_percent || 0,
          category: raw.category || 'other',
          retailer: raw.retailer || 'Unknown',
          found_at: scanned_at,
          expires_at: null,
          is_saved: false,
          is_dismissed: false,
          added_to_inventory: false,
          created_at: new Date().toISOString(),
        }
        freshDeals.push(deal)
      }

      if (freshDeals.length > 0) {
        if (!isSupabaseConfigured()) {
          const cached = await getCachedData('deals')
          await cacheData('deals', [...freshDeals, ...cached].slice(0, 500))
        } else {
          for (let i = 0; i < freshDeals.length; i += 20) {
            const batch = freshDeals.slice(i, i + 20).map(({ id: _id, created_at: _ca, ...rest }) => rest)
            await supabase.from('deals').insert(batch)
          }
        }

        setDeals((prev) => [...freshDeals, ...prev])

        // Send browser notifications for matching deals
        if ('Notification' in window && Notification.permission === 'granted') {
          const topDeal = freshDeals[0]
          new Notification('New Staging Deals Found!', {
            body: `${freshDeals.length} new deals — "${topDeal.title}" ${topDeal.sale_price > 0 ? `$${topDeal.sale_price}` : ''}`,
            icon: '/pwa-192x192.png',
          })
        }
      }

      localStorage.setItem('deals_last_scan', scanned_at)
      setLastScanAt(scanned_at)

      return { newCount: freshDeals.length, total: newDeals.length, newDealIds: freshDeals.map((d) => d.id) }
    } catch {
      // Never let scanning crash — return 0 results
      return { newCount: 0, total: 0, newDealIds: [] as string[] }
    } finally {
      setScanning(false)
    }
  }

  // Save / dismiss / mark a deal
  const updateDeal = async (id: string, updates: Partial<DealInsert>) => {
    if (!isSupabaseConfigured()) {
      const cached = await getCachedData('deals')
      const updated = cached.map((d) => (d.id === id ? { ...d, ...updates } : d))
      await cacheData('deals', updated)
      setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, ...updates } : d)))
      return
    }

    await supabase.from('deals').update(updates).eq('id', id)
    setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, ...updates } : d)))
  }

  // Delete old dismissed deals
  const cleanupDeals = async () => {
    if (!isSupabaseConfigured()) {
      const cached = await getCachedData('deals')
      const kept = cached.filter((d) => !d.is_dismissed)
      await cacheData('deals', kept)
      setDeals(kept)
      return
    }

    await supabase.from('deals').delete().eq('is_dismissed', true)
    await fetchDeals()
  }

  // Auto-scan on load if last scan was long ago
  useEffect(() => {
    const interval = parseInt(localStorage.getItem(SCAN_INTERVAL_KEY) || '', 10) || DEFAULT_SCAN_INTERVAL
    const lastScan = localStorage.getItem('deals_last_scan')
    if (!lastScan) return // first time, let user hit scan manually

    const elapsed = Date.now() - new Date(lastScan).getTime()
    if (elapsed > interval && watches.some((w) => w.active)) {
      // Auto-scan in the background after a short delay
      const timer = setTimeout(() => {
        scanDeals().catch(() => { /* silent background fail */ })
      }, 3000)
      return () => clearTimeout(timer)
    }
  }, [watches.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const savedDeals = deals.filter((d) => d.is_saved)
  const activeDeals = deals.filter((d) => !d.is_dismissed)

  return {
    deals: activeDeals,
    savedDeals,
    watches,
    loading,
    scanning,
    lastScanAt,
    scanDeals,
    addWatch,
    updateWatch,
    deleteWatch,
    updateDeal,
    cleanupDeals,
    refetch: fetchDeals,
  }
}
