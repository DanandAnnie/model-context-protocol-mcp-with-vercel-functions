export type PropertyType = 'house' | 'condo' | 'townhouse' | 'apartment' | 'other'
export type ItemCondition = 'excellent' | 'good' | 'fair' | 'poor'
export type ItemStatus = 'available' | 'staged' | 'damaged' | 'retired'
export type LocationType = 'storage' | 'property'

export type ItemCategory =
  | 'furniture'
  | 'lighting'
  | 'artwork'
  | 'textiles'
  | 'accessories'
  | 'rugs'
  | 'outdoor'
  | 'kitchen'
  | 'bathroom'
  | 'electronics'
  | 'other'

export interface Property {
  id: string
  name: string
  address: string
  city: string
  bedrooms: number
  bathrooms: number
  sqft: number
  property_type: PropertyType
  notes: string
  photo_url: string
  created_at: string
  updated_at: string
}

export interface StorageUnit {
  id: string
  name: string
  address: string
  unit_number: string
  size: string
  monthly_cost: number
  notes: string
  photo_url: string
  created_at: string
  updated_at: string
}

export interface Item {
  id: string
  name: string
  category: ItemCategory
  subcategory: string
  value: number
  condition: ItemCondition
  date_acquired: string | null
  notes: string
  photo_url: string
  current_location_type: LocationType
  current_storage_id: string | null
  current_property_id: string | null
  status: ItemStatus
  created_at: string
  updated_at: string
}

export interface ItemImage {
  id: string
  item_id: string
  image_url: string
  is_primary: boolean
  uploaded_at: string
}

export interface StagingHistory {
  id: string
  item_id: string
  from_location_type: LocationType | null
  from_storage_id: string | null
  from_property_id: string | null
  to_location_type: LocationType
  to_storage_id: string | null
  to_property_id: string | null
  moved_at: string
  notes: string
}

export type PropertyInsert = Omit<Property, 'id' | 'created_at' | 'updated_at'>
export type StorageUnitInsert = Omit<StorageUnit, 'id' | 'created_at' | 'updated_at'>
export type ItemInsert = Omit<Item, 'id' | 'created_at' | 'updated_at'>
export type StagingHistoryInsert = Omit<StagingHistory, 'id' | 'moved_at'>
