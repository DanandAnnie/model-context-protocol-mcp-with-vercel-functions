import { useState, useEffect, useCallback } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { cacheData, getCachedData, isStoreInitialized, markStoreInitialized } from '../lib/offline'
import { useVisibilityRefetch } from './useVisibilityRefetch'
import type { Property, PropertyInsert } from '../lib/database.types'

const propDefaults = { monthly_fee: 0, staging_start_date: null as string | null }

const DEMO_PROPERTIES: Property[] = [
  { ...propDefaults, id: '1', name: 'Lakewood Estate', address: '142 Lakewood Dr', city: 'Austin', bedrooms: 4, bathrooms: 3.5, sqft: 3200, property_type: 'house', monthly_fee: 2500, staging_start_date: '2024-01-01', notes: 'Luxury lakefront property', photo_url: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { ...propDefaults, id: '2', name: 'Downtown Loft', address: '88 Congress Ave #401', city: 'Austin', bedrooms: 2, bathrooms: 2, sqft: 1400, property_type: 'condo', monthly_fee: 1800, staging_start_date: '2024-03-01', notes: 'Modern downtown condo', photo_url: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { ...propDefaults, id: '3', name: 'Hillside Villa', address: '2200 Barton Creek Blvd', city: 'Austin', bedrooms: 5, bathrooms: 4, sqft: 4100, property_type: 'house', monthly_fee: 3200, staging_start_date: '2024-02-01', notes: 'Hill country views', photo_url: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { ...propDefaults, id: '4', name: 'Midtown Townhome', address: '556 W 6th St', city: 'Austin', bedrooms: 3, bathrooms: 2.5, sqft: 1850, property_type: 'townhouse', monthly_fee: 2000, staging_start_date: '2024-06-01', notes: 'Walking distance to restaurants', photo_url: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { ...propDefaults, id: '5', name: 'East Side Bungalow', address: '1012 E Cesar Chavez', city: 'Austin', bedrooms: 2, bathrooms: 1, sqft: 950, property_type: 'house', monthly_fee: 1200, staging_start_date: '2024-04-01', notes: 'Charming renovated bungalow', photo_url: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
]

// Migrate existing properties that don't have the new fields
function migrateProperties(props: Property[]): { migrated: Property[]; changed: boolean } {
  let changed = false
  const migrated = props.map((p) => {
    const raw = p as unknown as Record<string, unknown>
    if (raw.monthly_fee === undefined) {
      changed = true
      return { ...p, monthly_fee: 0, staging_start_date: null }
    }
    return p
  })
  return { migrated, changed }
}

export function useProperties() {
  const [properties, setProperties] = useState<Property[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchProperties = useCallback(async () => {
    setLoading(true)
    setError(null)

    if (!isSupabaseConfigured()) {
      const cached = await getCachedData('properties')
      if (cached.length > 0) {
        const { migrated, changed } = migrateProperties(cached as Property[])
        if (changed) await cacheData('properties', migrated)
        setProperties(migrated)
        markStoreInitialized('properties')
      } else if (!isStoreInitialized('properties')) {
        await cacheData('properties', DEMO_PROPERTIES)
        setProperties(DEMO_PROPERTIES)
        markStoreInitialized('properties')
      } else {
        setProperties([])
      }
      setLoading(false)
      return
    }

    try {
      const { data, error: err } = await supabase
        .from('properties')
        .select('*')
        .order('name')

      if (err) throw err
      setProperties(data || [])
      if (data) await cacheData('properties', data)
    } catch (err) {
      const cached = await getCachedData('properties')
      if (cached.length > 0) {
        setProperties(cached)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch properties')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchProperties() }, [fetchProperties])

  // Refetch when app resumes from background (critical for iOS)
  useVisibilityRefetch(fetchProperties, isSupabaseConfigured())

  // Realtime: subscribe to changes from other devices
  useEffect(() => {
    if (!isSupabaseConfigured()) return

    const channel = supabase
      .channel('properties-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'properties' }, () => {
        fetchProperties()
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [fetchProperties])

  const addProperty = async (property: PropertyInsert) => {
    if (!isSupabaseConfigured()) {
      const newProp: Property = {
        ...property,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      const updated = [...properties, newProp]
      setProperties(updated)
      await cacheData('properties', updated)
      return newProp
    }

    const { data, error: err } = await supabase
      .from('properties')
      .insert(property)
      .select()
      .single()

    if (err) throw err
    await fetchProperties()
    return data
  }

  const updateProperty = async (id: string, updates: Partial<PropertyInsert>) => {
    if (!isSupabaseConfigured()) {
      const updated = properties.map((p) =>
        p.id === id ? { ...p, ...updates, updated_at: new Date().toISOString() } : p,
      )
      setProperties(updated)
      await cacheData('properties', updated)
      return
    }

    const { error: err } = await supabase
      .from('properties')
      .update(updates)
      .eq('id', id)

    if (err) throw err
    await fetchProperties()
  }

  const deleteProperty = async (id: string) => {
    if (!isSupabaseConfigured()) {
      const updated = properties.filter((p) => p.id !== id)
      setProperties(updated)
      await cacheData('properties', updated)
      return
    }

    const { error: err } = await supabase
      .from('properties')
      .delete()
      .eq('id', id)

    if (err) throw err
    await fetchProperties()
  }

  return { properties, loading, error, addProperty, updateProperty, deleteProperty, refetch: fetchProperties }
}
