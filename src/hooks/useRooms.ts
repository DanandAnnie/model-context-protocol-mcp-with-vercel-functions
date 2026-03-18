import { useState, useEffect, useCallback } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { cacheData, getCachedData } from '../lib/offline'
import type { Room, RoomInsert } from '../lib/database.types'

/**
 * Migrate rooms from localStorage (old format) into IndexedDB cache
 * so existing data isn't lost when switching to the new sync system.
 */
async function migrateLocalStorageRooms(propertyId: string): Promise<Room[]> {
  const key = `property_rooms_${propertyId}`
  const stored = localStorage.getItem(key)
  if (!stored) return []

  try {
    const oldRooms: Array<{ id: string; name: string; length_ft: number; width_ft: number }> = JSON.parse(stored)
    const now = new Date().toISOString()
    const migrated: Room[] = oldRooms.map((r) => ({
      id: r.id,
      property_id: propertyId,
      name: r.name,
      length_ft: r.length_ft,
      width_ft: r.width_ft,
      created_at: now,
      updated_at: now,
    }))

    // Merge into IndexedDB cache
    const existing = await getCachedData('property_rooms')
    const existingIds = new Set(existing.map((r) => r.id))
    const newRooms = migrated.filter((r) => !existingIds.has(r.id))
    if (newRooms.length > 0) {
      await cacheData('property_rooms', [...existing, ...newRooms])
    }

    // Remove old localStorage key after successful migration
    localStorage.removeItem(key)
    return migrated
  } catch {
    return []
  }
}

export function useRooms(propertyId?: string) {
  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)

  const fetchRooms = useCallback(async () => {
    if (!propertyId) {
      setRooms([])
      setLoading(false)
      return
    }

    setLoading(true)

    // Always check for localStorage migration first
    await migrateLocalStorageRooms(propertyId)

    if (!isSupabaseConfigured()) {
      const cached = await getCachedData('property_rooms')
      const filtered = cached.filter((r) => r.property_id === propertyId)
      setRooms(filtered)
      setLoading(false)
      return
    }

    try {
      const { data, error } = await supabase
        .from('property_rooms')
        .select('*')
        .eq('property_id', propertyId)
        .order('name')

      if (error) throw error
      setRooms(data || [])
      if (data) {
        // Merge into cache without overwriting other properties' rooms
        const allCached = await getCachedData('property_rooms')
        const otherRooms = allCached.filter((r) => r.property_id !== propertyId)
        await cacheData('property_rooms', [...otherRooms, ...data])
      }
    } catch {
      // Supabase table may not exist yet — fall back to cache
      const cached = await getCachedData('property_rooms')
      const filtered = cached.filter((r) => r.property_id === propertyId)
      setRooms(filtered)
    } finally {
      setLoading(false)
    }
  }, [propertyId])

  useEffect(() => { fetchRooms() }, [fetchRooms])

  // Realtime sync — listen for changes from other devices
  useEffect(() => {
    if (!isSupabaseConfigured() || !propertyId) return

    const channel = supabase
      .channel(`property-rooms-sync-${propertyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'property_rooms' }, (payload) => {
        // Only refetch if the change is for our property
        const row = payload.new as Room | undefined
        const oldRow = payload.old as Partial<Room> | undefined
        if (row?.property_id === propertyId || oldRow?.property_id === propertyId) {
          fetchRooms()
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [fetchRooms, propertyId])

  const addRoom = async (room: RoomInsert) => {
    const newRoom: Room = {
      ...room,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    if (!isSupabaseConfigured()) {
      const allCached = await getCachedData('property_rooms')
      await cacheData('property_rooms', [...allCached, newRoom])
      setRooms((prev) => [...prev, newRoom])
      return newRoom
    }

    try {
      const { data, error } = await supabase
        .from('property_rooms')
        .insert(room)
        .select()
        .single()

      if (error) throw error
      await fetchRooms()
      return data
    } catch {
      // Supabase table may not exist — save locally
      const allCached = await getCachedData('property_rooms')
      await cacheData('property_rooms', [...allCached, newRoom])
      setRooms((prev) => [...prev, newRoom])
      return newRoom
    }
  }

  const deleteRoom = async (id: string) => {
    if (!isSupabaseConfigured()) {
      const allCached = await getCachedData('property_rooms')
      await cacheData('property_rooms', allCached.filter((r) => r.id !== id))
      setRooms((prev) => prev.filter((r) => r.id !== id))
      return
    }

    try {
      const { error } = await supabase.from('property_rooms').delete().eq('id', id)
      if (error) throw error
      await fetchRooms()
    } catch {
      // Supabase table may not exist — delete locally
      const allCached = await getCachedData('property_rooms')
      await cacheData('property_rooms', allCached.filter((r) => r.id !== id))
      setRooms((prev) => prev.filter((r) => r.id !== id))
    }
  }

  const updateRoom = async (id: string, updates: Partial<RoomInsert>) => {
    const updatedFields = { ...updates, updated_at: new Date().toISOString() }

    if (!isSupabaseConfigured()) {
      const allCached = await getCachedData('property_rooms')
      const updated = allCached.map((r) =>
        r.id === id ? { ...r, ...updatedFields } : r,
      )
      await cacheData('property_rooms', updated)
      setRooms((prev) => prev.map((r) => (r.id === id ? { ...r, ...updatedFields } : r)))
      return
    }

    try {
      const { error } = await supabase
        .from('property_rooms')
        .update(updatedFields)
        .eq('id', id)

      if (error) throw error
      await fetchRooms()
    } catch {
      // Supabase table may not exist — update locally
      const allCached = await getCachedData('property_rooms')
      const updated = allCached.map((r) =>
        r.id === id ? { ...r, ...updatedFields } : r,
      )
      await cacheData('property_rooms', updated)
      setRooms((prev) => prev.map((r) => (r.id === id ? { ...r, ...updatedFields } : r)))
    }
  }

  return { rooms, loading, addRoom, updateRoom, deleteRoom, refetch: fetchRooms }
}
