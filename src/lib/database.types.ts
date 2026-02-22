export type PropertyType = 'house' | 'condo' | 'townhouse' | 'apartment' | 'other'
export type ItemCondition = 'excellent' | 'good' | 'fair' | 'poor'
export type ItemStatus = 'available' | 'staged' | 'damaged' | 'retired'
export type LocationType = 'storage' | 'property'
export type PaymentMethod = 'cash' | 'credit_card' | 'debit_card' | 'venmo' | 'zelle' | 'paypal' | 'check' | 'square' | 'other'

export type ItemCategory =
  | 'kitchen & dining'
  | 'bedroom'
  | 'living room'
  | 'office'
  | 'bathroom'
  | 'outdoor'
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
  monthly_fee: number
  staging_start_date: string | null
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
  purchase_price: number
  purchase_date: string | null
  payment_method: PaymentMethod
  receipt_url: string
  useful_life_years: number
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

export interface StagingPayment {
  id: string
  property_id: string
  amount: number
  payment_date: string
  payment_method: PaymentMethod
  month_covered: string // e.g. "2025-01"
  square_transaction_id: string
  notes: string
  created_at: string
}

export type ExpenseCategory = 'design_fee' | 'movers' | 'travel' | 'supplies' | 'other'

export interface PropertyExpense {
  id: string
  property_id: string
  category: ExpenseCategory
  description: string
  amount: number
  expense_date: string | null
  notes: string
  created_at: string
  updated_at: string
}

export type PropertyExpenseInsert = Omit<PropertyExpense, 'id' | 'created_at' | 'updated_at'>

// Deal Finder types
export type DealSource = 'wayfair' | 'home_depot' | 'overstock' | 'target' | 'amazon' | 'slickdeals' | 'facebook_marketplace' | 'other'

export interface Deal {
  id: string
  title: string
  description: string
  source: DealSource
  source_url: string
  image_url: string
  original_price: number
  sale_price: number
  discount_percent: number
  category: string
  retailer: string
  found_at: string
  expires_at: string | null
  is_saved: boolean
  is_dismissed: boolean
  added_to_inventory: boolean
  created_at: string
}

export type DealInsert = Omit<Deal, 'id' | 'created_at'>

export interface DealWatch {
  id: string
  keywords: string
  category: string
  max_price: number
  min_discount: number
  sources: DealSource[]
  notify: boolean
  active: boolean
  created_at: string
  updated_at: string
}

export type DealWatchInsert = Omit<DealWatch, 'id' | 'created_at' | 'updated_at'>
export type StagingPaymentInsert = Omit<StagingPayment, 'id' | 'created_at'>
export type PropertyInsert = Omit<Property, 'id' | 'created_at' | 'updated_at'>
export type StorageUnitInsert = Omit<StorageUnit, 'id' | 'created_at' | 'updated_at'>
export type ItemInsert = Omit<Item, 'id' | 'created_at' | 'updated_at'>
export type StagingHistoryInsert = Omit<StagingHistory, 'id' | 'moved_at'>
