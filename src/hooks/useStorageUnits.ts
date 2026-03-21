import { useState, useEffect, useCallback } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { cacheData, getCachedData, isStoreInitialized, markStoreInitialized } from '../lib/offline'
import { useRealtimeSync } from './useRealtimeSync'
import type { StorageUnit, StorageUnitInsert } from '../lib/database.types'

const DEMO_UNITS: StorageUnit[] = [
  { id: '1', name: 'SecureStore North', address: '4500 N Lamar Blvd', unit_number: 'A-12', size: '10x20', monthly_cost: 185, notes: 'Climate controlled', photo_url: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: '2', name: 'Downtown Mini Storage', address: '200 E 3rd St', unit_number: 'B-05', size: '10x10', monthly_cost: 120, notes: 'Easy access, ground floor', photo_url: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: '3', name: 'South Austin Storage', address: '8800 S Congress Ave', unit_number: 'C-22', size: '10x30', monthly_cost: 250, notes: 'Large unit for furniture sets', photo_url: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
]

export function useStorageUnits() {
  const [units, setUnits] = useState<StorageUnit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchUnits = useCallback(async () => {
    setLoading(true)
    setError(null)

    if (!isSupabaseConfigured()) {
      const cached = await getCachedData('storage_units')
      if (cached.length > 0) {
        setUnits(cached)
        markStoreInitialized('storage_units')
      } else if (!isStoreInitialized('storage_units')) {
        await cacheData('storage_units', DEMO_UNITS)
        setUnits(DEMO_UNITS)
        markStoreInitialized('storage_units')
      } else {
        setUnits([])
      }
      setLoading(false)
      return
    }

    try {
      const { data, error: err } = await supabase
        .from('storage_units')
        .select('*')
        .order('name')

      if (err) throw err
      setUnits(data || [])
      if (data) await cacheData('storage_units', data)
    } catch (err) {
      const cached = await getCachedData('storage_units')
      if (cached.length > 0) {
        setUnits(cached)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch storage units')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchUnits() }, [fetchUnits])

  // Realtime sync with auto-reconnect on iOS background resume + polling fallback
  useRealtimeSync('storage_units', 'storage-units-sync', fetchUnits)

  const addUnit = async (unit: StorageUnitInsert) => {
    if (!isSupabaseConfigured()) {
      const newUnit: StorageUnit = {
        ...unit,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      const updated = [...units, newUnit]
      setUnits(updated)
      await cacheData('storage_units', updated)
      return newUnit
    }

    const { data, error: err } = await supabase
      .from('storage_units')
      .insert(unit)
      .select()
      .single()

    if (err) throw err
    await fetchUnits()
    return data
  }

  const updateUnit = async (id: string, updates: Partial<StorageUnitInsert>) => {
    if (!isSupabaseConfigured()) {
      const updated = units.map((u) =>
        u.id === id ? { ...u, ...updates, updated_at: new Date().toISOString() } : u,
      )
      setUnits(updated)
      await cacheData('storage_units', updated)
      return
    }

    const { error: err } = await supabase
      .from('storage_units')
      .update(updates)
      .eq('id', id)

    if (err) throw err
    await fetchUnits()
  }

  const deleteUnit = async (id: string) => {
    if (!isSupabaseConfigured()) {
      const updated = units.filter((u) => u.id !== id)
      setUnits(updated)
      await cacheData('storage_units', updated)
      return
    }

    const { error: err } = await supabase
      .from('storage_units')
      .delete()
      .eq('id', id)

    if (err) throw err
    await fetchUnits()
  }

  return { units, loading, error, addUnit, updateUnit, deleteUnit, refetch: fetchUnits }
}
