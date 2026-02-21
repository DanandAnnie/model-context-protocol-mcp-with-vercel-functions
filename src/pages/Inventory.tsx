import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Package, Search, Filter, PlusCircle } from 'lucide-react'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import { useStorageUnits } from '../hooks/useStorageUnits'
import ItemCard from '../components/ItemCard'
import type { ItemCategory, ItemStatus, ItemCondition } from '../lib/database.types'

const CATEGORIES: ItemCategory[] = [
  'furniture', 'lighting', 'artwork', 'textiles', 'accessories',
  'rugs', 'outdoor', 'kitchen', 'bathroom', 'electronics', 'other',
]
const STATUSES: ItemStatus[] = ['available', 'staged', 'damaged', 'retired']
const CONDITIONS: ItemCondition[] = ['excellent', 'good', 'fair', 'poor']

export default function Inventory() {
  const { items, loading, deleteItem } = useItems()
  const { properties } = useProperties()
  const { units } = useStorageUnits()

  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [conditionFilter, setConditionFilter] = useState<string>('all')
  const [locationFilter, setLocationFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<'name' | 'value' | 'updated'>('name')
  const [showFilters, setShowFilters] = useState(false)

  const locationName = (item: typeof items[0]) => {
    if (item.current_location_type === 'property') {
      return properties.find((p) => p.id === item.current_property_id)?.name || 'Property'
    }
    return units.find((u) => u.id === item.current_storage_id)?.name || 'Storage'
  }

  const filtered = useMemo(() => {
    let result = items

    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q) ||
          i.subcategory.toLowerCase().includes(q) ||
          i.notes.toLowerCase().includes(q),
      )
    }

    if (categoryFilter !== 'all') {
      result = result.filter((i) => i.category === categoryFilter)
    }
    if (statusFilter !== 'all') {
      result = result.filter((i) => i.status === statusFilter)
    }
    if (conditionFilter !== 'all') {
      result = result.filter((i) => i.condition === conditionFilter)
    }
    if (locationFilter !== 'all') {
      result = result.filter((i) => i.current_location_type === locationFilter)
    }

    result = [...result].sort((a, b) => {
      if (sortBy === 'value') return b.value - a.value
      if (sortBy === 'updated') return b.updated_at.localeCompare(a.updated_at)
      return a.name.localeCompare(b.name)
    })

    return result
  }, [items, search, categoryFilter, statusFilter, conditionFilter, locationFilter, sortBy])

  const totalValue = filtered.reduce((sum, i) => sum + i.value, 0)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Full Inventory</h1>
          <p className="text-slate-500 text-sm mt-1">
            {filtered.length} items &middot; ${totalValue.toLocaleString()} total value
          </p>
        </div>
        <Link
          to="/add-item"
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
        >
          <PlusCircle size={16} />
          Add Item
        </Link>
      </div>

      {/* Search bar */}
      <div className="flex gap-3">
        <div className="flex-1 relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items..."
            className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm border transition-colors ${
            showFilters
              ? 'bg-blue-50 border-blue-300 text-blue-700'
              : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <Filter size={16} />
          Filters
        </button>
      </div>

      {/* Filters panel */}
      {showFilters && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 grid grid-cols-2 md:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Category</label>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
            >
              <option value="all">All</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c} className="capitalize">{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
            >
              <option value="all">All</option>
              {STATUSES.map((s) => (
                <option key={s} value={s} className="capitalize">{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Condition</label>
            <select
              value={conditionFilter}
              onChange={(e) => setConditionFilter(e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
            >
              <option value="all">All</option>
              {CONDITIONS.map((c) => (
                <option key={c} value={c} className="capitalize">{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Location</label>
            <select
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
            >
              <option value="all">All</option>
              <option value="storage">Storage</option>
              <option value="property">Property</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Sort By</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'name' | 'value' | 'updated')}
              className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
            >
              <option value="name">Name</option>
              <option value="value">Value (High to Low)</option>
              <option value="updated">Recently Updated</option>
            </select>
          </div>
        </div>
      )}

      {/* Items list */}
      <div className="space-y-2">
        {filtered.map((item) => (
          <div key={item.id} className="group relative">
            <ItemCard item={item} locationName={locationName(item)} />
            <button
              onClick={() => {
                if (confirm(`Delete "${item.name}"?`)) deleteItem(item.id)
              }}
              className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 text-xs px-2 py-1 bg-red-50 text-red-600 rounded hover:bg-red-100 transition-all"
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <Package size={40} className="mx-auto mb-3 opacity-50" />
          <p>No items match your filters</p>
        </div>
      )}
    </div>
  )
}
