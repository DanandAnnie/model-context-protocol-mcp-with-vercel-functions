import { useState, useEffect, useCallback } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { cacheData, getCachedData, isStoreInitialized, markStoreInitialized } from '../lib/offline'
import type { Item, ItemInsert, ItemCategory } from '../lib/database.types'

const VALID_CATEGORIES: ItemCategory[] = [
  'kitchen & dining', 'bedroom', 'living room', 'office',
  'bathroom', 'outdoor', 'other',
]

// Migrate old category values to the new room-based categories
function migrateCategory(category: string, subcategory: string): ItemCategory {
  const cat = category.toLowerCase().trim()
  const sub = subcategory.toLowerCase().trim()

  // Already a valid category
  if (VALID_CATEGORIES.includes(cat as ItemCategory)) return cat as ItemCategory

  // Map old categories based on name + subcategory context
  if (cat === 'kitchen' || cat === 'appliances' || cat === 'kitchen appliances') return 'kitchen & dining'
  if (cat === 'dining') return 'kitchen & dining'
  if (sub === 'bedroom' || sub === 'bed' || sub === 'bed frames' || sub === 'nightstand' || sub === 'dresser') return 'bedroom'
  if (sub === 'bathroom' || sub === 'bath' || sub === 'mirror' || sub === 'mirrors') return 'bathroom'
  if (sub === 'kitchen' || sub === 'dining' || sub === 'bar stools' || sub === 'seating' && cat === 'kitchen') return 'kitchen & dining'
  if (sub === 'outdoor' || sub === 'patio' || sub === 'garden') return 'outdoor'
  if (sub === 'desk' || sub === 'office' || sub === 'computer') return 'office'
  if (cat === 'furniture' || cat === 'lighting' || cat === 'textiles' || cat === 'accessories' || cat === 'artwork' || cat === 'rugs') return 'living room'
  if (cat === 'electronics') return 'office'

  return 'other'
}

function migrateItems(items: Item[]): { migrated: Item[]; changed: boolean } {
  let changed = false
  const migrated = items.map((item) => {
    const newCategory = migrateCategory(item.category, item.subcategory)
    if (newCategory !== item.category) {
      changed = true
      return { ...item, category: newCategory, updated_at: new Date().toISOString() }
    }
    return item
  })
  return { migrated, changed }
}

const DEMO_ITEMS: Item[] = [
  { id: 'i1', name: 'Mid-Century Sofa', category: 'living room', subcategory: 'seating', value: 2400, condition: 'excellent', date_acquired: '2024-03-15', notes: 'Gray velvet, 3-seat', photo_url: '', current_location_type: 'storage', current_storage_id: '1', current_property_id: null, status: 'available', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'i2', name: 'Abstract Canvas Print', category: 'living room', subcategory: 'artwork', value: 350, condition: 'excellent', date_acquired: '2024-05-01', notes: '48x36 framed', photo_url: '', current_location_type: 'property', current_storage_id: null, current_property_id: '1', status: 'staged', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'i3', name: 'Brass Floor Lamp', category: 'living room', subcategory: 'lighting', value: 450, condition: 'good', date_acquired: '2024-01-20', notes: 'Adjustable height', photo_url: '', current_location_type: 'storage', current_storage_id: '1', current_property_id: null, status: 'available', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'i4', name: 'Wool Area Rug 8x10', category: 'living room', subcategory: 'rugs', value: 1800, condition: 'good', date_acquired: '2023-11-10', notes: 'Neutral tones, hand-knotted', photo_url: '', current_location_type: 'property', current_storage_id: null, current_property_id: '2', status: 'staged', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'i5', name: 'Dining Table Set', category: 'kitchen & dining', subcategory: 'tables', value: 3200, condition: 'excellent', date_acquired: '2024-06-01', notes: 'Walnut, seats 8', photo_url: '', current_location_type: 'storage', current_storage_id: '2', current_property_id: null, status: 'available', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'i6', name: 'Throw Pillow Set (4)', category: 'living room', subcategory: 'textiles', value: 180, condition: 'good', date_acquired: '2024-04-10', notes: 'Mixed patterns, blue tones', photo_url: '', current_location_type: 'property', current_storage_id: null, current_property_id: '1', status: 'staged', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'i7', name: 'Ceramic Vase Collection', category: 'living room', subcategory: 'accessories', value: 220, condition: 'excellent', date_acquired: '2024-02-14', notes: 'Set of 3, white matte', photo_url: '', current_location_type: 'storage', current_storage_id: '3', current_property_id: null, status: 'available', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'i8', name: 'King Bed Frame', category: 'bedroom', subcategory: 'bed frames', value: 1600, condition: 'good', date_acquired: '2024-01-05', notes: 'Upholstered, beige linen', photo_url: '', current_location_type: 'property', current_storage_id: null, current_property_id: '3', status: 'staged', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'i9', name: 'Pendant Light Fixture', category: 'kitchen & dining', subcategory: 'lighting', value: 380, condition: 'excellent', date_acquired: '2024-07-01', notes: 'Globe glass, brass finish', photo_url: '', current_location_type: 'storage', current_storage_id: '1', current_property_id: null, status: 'available', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'i10', name: 'Outdoor Lounge Chair', category: 'outdoor', subcategory: 'seating', value: 750, condition: 'fair', date_acquired: '2023-09-15', notes: 'Teak wood, needs re-oiling', photo_url: '', current_location_type: 'storage', current_storage_id: '3', current_property_id: null, status: 'available', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'i11', name: 'Bathroom Mirror', category: 'bathroom', subcategory: 'mirrors', value: 290, condition: 'excellent', date_acquired: '2024-05-20', notes: 'Round, gold frame, 30"', photo_url: '', current_location_type: 'property', current_storage_id: null, current_property_id: '4', status: 'staged', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'i12', name: 'Kitchen Bar Stools (3)', category: 'kitchen & dining', subcategory: 'seating', value: 540, condition: 'good', date_acquired: '2024-03-01', notes: 'Swivel, counter height', photo_url: '', current_location_type: 'property', current_storage_id: null, current_property_id: '5', status: 'staged', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
]

export function useItems() {
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchItems = useCallback(async () => {
    setLoading(true)
    setError(null)

    if (!isSupabaseConfigured()) {
      const cached = await getCachedData('items')
      if (cached.length > 0) {
        const { migrated, changed } = migrateItems(cached as Item[])
        if (changed) await cacheData('items', migrated)
        setItems(migrated)
        markStoreInitialized('items')
      } else if (!isStoreInitialized('items')) {
        await cacheData('items', DEMO_ITEMS)
        setItems(DEMO_ITEMS)
        markStoreInitialized('items')
      } else {
        setItems([])
      }
      setLoading(false)
      return
    }

    try {
      const { data, error: err } = await supabase
        .from('items')
        .select('*')
        .order('name')

      if (err) throw err
      setItems(data || [])
      if (data) await cacheData('items', data)
    } catch (err) {
      const cached = await getCachedData('items')
      if (cached.length > 0) {
        setItems(cached)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch items')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchItems() }, [fetchItems])

  // Realtime: subscribe to changes from other devices
  useEffect(() => {
    if (!isSupabaseConfigured()) return

    const channel = supabase
      .channel('items-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, () => {
        fetchItems()
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [fetchItems])

  const addItem = async (item: ItemInsert) => {
    if (!isSupabaseConfigured()) {
      const newItem: Item = {
        ...item,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      const updated = [...items, newItem]
      setItems(updated)
      await cacheData('items', updated)
      return newItem
    }

    const { data, error: err } = await supabase
      .from('items')
      .insert(item)
      .select()
      .single()

    if (err) throw err
    await fetchItems()
    return data
  }

  const updateItem = async (id: string, updates: Partial<ItemInsert>) => {
    if (!isSupabaseConfigured()) {
      const updated = items.map((i) =>
        i.id === id ? { ...i, ...updates, updated_at: new Date().toISOString() } : i,
      )
      setItems(updated)
      await cacheData('items', updated)
      return
    }

    const { error: err } = await supabase
      .from('items')
      .update(updates)
      .eq('id', id)

    if (err) throw err
    await fetchItems()
  }

  const deleteItem = async (id: string) => {
    if (!isSupabaseConfigured()) {
      const updated = items.filter((i) => i.id !== id)
      setItems(updated)
      await cacheData('items', updated)
      return
    }

    const { error: err } = await supabase
      .from('items')
      .delete()
      .eq('id', id)

    if (err) throw err
    await fetchItems()
  }

  const moveItem = async (
    itemId: string,
    toLocationType: 'storage' | 'property',
    toId: string,
  ) => {
    const item = items.find((i) => i.id === itemId)
    if (!item) return

    const updates: Partial<ItemInsert> = {
      current_location_type: toLocationType,
      current_storage_id: toLocationType === 'storage' ? toId : null,
      current_property_id: toLocationType === 'property' ? toId : null,
      status: toLocationType === 'property' ? 'staged' : 'available',
    }

    await updateItem(itemId, updates)

    if (isSupabaseConfigured()) {
      await supabase.from('staging_history').insert({
        item_id: itemId,
        from_location_type: item.current_location_type,
        from_storage_id: item.current_storage_id,
        from_property_id: item.current_property_id,
        to_location_type: toLocationType,
        to_storage_id: toLocationType === 'storage' ? toId : null,
        to_property_id: toLocationType === 'property' ? toId : null,
        notes: '',
      })
    }
  }

  return { items, loading, error, addItem, updateItem, deleteItem, moveItem, refetch: fetchItems }
}
