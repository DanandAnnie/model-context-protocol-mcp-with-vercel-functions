import { useState, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Package, Search, Filter, PlusCircle, ArrowLeft, ChevronRight,
  UtensilsCrossed, Bed, Sofa, Monitor, Bath, TreePine, MoreHorizontal, LayoutGrid,
  CheckSquare, Square, Trash2, ArrowRightLeft, XCircle,
} from 'lucide-react'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import { useStorageUnits } from '../hooks/useStorageUnits'
import ItemCard from '../components/ItemCard'
import type { ItemCategory, ItemStatus, ItemCondition } from '../lib/database.types'

const CATEGORIES: { key: ItemCategory; label: string; icon: typeof Package; color: string; bg: string }[] = [
  { key: 'kitchen & dining', label: 'Kitchen & Dining', icon: UtensilsCrossed, color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/30' },
  { key: 'bedroom', label: 'Bedroom', icon: Bed, color: 'text-indigo-400', bg: 'bg-indigo-500/10 border-indigo-500/30' },
  { key: 'living room', label: 'Living Room', icon: Sofa, color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/30' },
  { key: 'office', label: 'Office', icon: Monitor, color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/30' },
  { key: 'bathroom', label: 'Bathroom', icon: Bath, color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/30' },
  { key: 'outdoor', label: 'Outdoor', icon: TreePine, color: 'text-green-400', bg: 'bg-green-500/10 border-green-500/30' },
  { key: 'other', label: 'Other', icon: MoreHorizontal, color: 'text-gray-400', bg: 'bg-gray-500/10 border-gray-500/30' },
]

const STATUSES: ItemStatus[] = ['available', 'staged', 'damaged', 'retired']
const CONDITIONS: ItemCondition[] = ['excellent', 'good', 'fair', 'poor']

export default function Inventory() {
  const navigate = useNavigate()
  const { items, loading, deleteItem, updateItem, moveItem } = useItems()
  const { properties } = useProperties()
  const { units } = useStorageUnits()

  // null = category overview, 'all' = all items, category key = filtered
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [conditionFilter, setConditionFilter] = useState<string>('all')
  const [locationFilter, setLocationFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<'name' | 'value' | 'updated'>('name')
  const [showFilters, setShowFilters] = useState(false)

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkMoveTarget, setBulkMoveTarget] = useState<string>('')

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map((i) => i.id)))
    }
  }

  const clearSelection = () => {
    setSelectedIds(new Set())
  }

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selectedIds.size} item${selectedIds.size !== 1 ? 's' : ''}? This cannot be undone.`)) return
    for (const id of selectedIds) {
      await deleteItem(id)
    }
    clearSelection()
  }

  const handleBulkStatusChange = async (newStatus: ItemStatus) => {
    for (const id of selectedIds) {
      await updateItem(id, { status: newStatus })
    }
    clearSelection()
  }

  const handleBulkMove = async () => {
    if (!bulkMoveTarget) return
    const isProperty = properties.some((p) => p.id === bulkMoveTarget)
    for (const id of selectedIds) {
      if (isProperty) {
        await moveItem(id, 'property', bulkMoveTarget)
      } else {
        await moveItem(id, 'storage', bulkMoveTarget)
      }
    }
    clearSelection()
  }

  const locationName = (item: typeof items[0]) => {
    if (item.current_location_type === 'property') {
      return properties.find((p) => p.id === item.current_property_id)?.name || 'Property'
    }
    return units.find((u) => u.id === item.current_storage_id)?.name || 'Storage'
  }

  // Count items per category
  const categoryCounts = useMemo(() => {
    const counts: Record<string, { count: number; value: number }> = {}
    for (const cat of CATEGORIES) {
      counts[cat.key] = { count: 0, value: 0 }
    }
    for (const item of items) {
      if (counts[item.category]) {
        counts[item.category].count++
        counts[item.category].value += item.value
      }
    }
    return counts
  }, [items])

  const totalValue = items.reduce((sum, i) => sum + i.value, 0)

  // Filter items when a category is selected
  const filtered = useMemo(() => {
    let result = items

    if (activeCategory && activeCategory !== 'all') {
      result = result.filter((i) => i.category === activeCategory)
    }

    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.subcategory.toLowerCase().includes(q) ||
          i.notes.toLowerCase().includes(q),
      )
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
  }, [items, activeCategory, search, statusFilter, conditionFilter, locationFilter, sortBy])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  // Category detail view — items filtered by selected category (or all)
  if (activeCategory) {
    const isAll = activeCategory === 'all'
    const catInfo = isAll ? null : CATEGORIES.find((c) => c.key === activeCategory)!
    const CatIcon = catInfo ? catInfo.icon : LayoutGrid
    const catColor = catInfo ? catInfo.color : 'text-blue-600'
    const catLabel = catInfo ? catInfo.label : 'All Items'
    const catValue = filtered.reduce((sum, i) => sum + i.value, 0)

    return (
      <div className="space-y-6">
        {/* Header with back button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setActiveCategory(null); setSearch(''); setShowFilters(false) }}
              className="p-2 -ml-2 rounded-lg hover:bg-slate-100 transition-colors"
            >
              <ArrowLeft size={20} className="text-slate-600" />
            </button>
            <div className="flex items-center gap-2">
              <CatIcon size={22} className={catColor} />
              <div>
                <h1 className="text-xl font-bold">{catLabel}</h1>
                <p className="text-slate-500 text-sm">
                  {filtered.length} item{filtered.length !== 1 ? 's' : ''} &middot; ${catValue.toLocaleString()} value
                </p>
              </div>
            </div>
          </div>
          <Link
            to="/add-item"
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
          >
            <PlusCircle size={16} />
            Add
          </Link>
        </div>

        {/* Search & filters */}
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search in ${catLabel}...`}
              className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm border transition-colors ${
              showFilters
                ? 'bg-violet-600/20 border-violet-500/40 text-violet-300'
                : 'border-slate-600 text-slate-400 hover:bg-slate-700'
            }`}
          >
            <Filter size={16} />
            Filters
          </button>
        </div>

        {showFilters && (
          <div className="bg-white rounded-xl border border-slate-200 p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
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

        {/* Bulk action toolbar */}
        {selectedIds.size > 0 && (
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3 flex items-center justify-between gap-3 sticky top-0 z-10">
            <div className="flex items-center gap-2">
              <button onClick={selectAll} className="text-xs text-blue-400 hover:text-blue-300">
                {selectedIds.size === filtered.length ? 'Deselect All' : 'Select All'}
              </button>
              <span className="text-sm font-medium text-blue-300">
                {selectedIds.size} selected
              </span>
            </div>
            <div className="flex items-center gap-2">
              {/* Status change */}
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) handleBulkStatusChange(e.target.value as ItemStatus)
                }}
                className="px-2 py-1.5 border border-blue-500/40 rounded text-xs bg-slate-800"
              >
                <option value="">Set Status...</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s} className="capitalize">{s}</option>
                ))}
              </select>

              {/* Move */}
              <select
                value={bulkMoveTarget}
                onChange={(e) => setBulkMoveTarget(e.target.value)}
                className="px-2 py-1.5 border border-blue-500/40 rounded text-xs bg-slate-800 max-w-[140px]"
              >
                <option value="">Move to...</option>
                <optgroup label="Properties">
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </optgroup>
                <optgroup label="Storage Units">
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </optgroup>
              </select>
              {bulkMoveTarget && (
                <button
                  onClick={handleBulkMove}
                  className="flex items-center gap-1 px-2 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700"
                >
                  <ArrowRightLeft size={12} />
                  Move
                </button>
              )}

              {/* Delete */}
              <button
                onClick={handleBulkDelete}
                className="flex items-center gap-1 px-2 py-1.5 bg-red-600 text-white text-xs rounded hover:bg-red-700"
              >
                <Trash2 size={12} />
                Delete
              </button>

              <button
                onClick={clearSelection}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded"
              >
                <XCircle size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Items list */}
        <div className="space-y-2">
          {filtered.map((item) => (
            <div key={item.id} className="group relative flex items-start gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); toggleSelection(item.id) }}
                className="mt-4 flex-shrink-0 text-slate-400 hover:text-blue-600"
              >
                {selectedIds.has(item.id) ? (
                  <CheckSquare size={18} className="text-blue-600" />
                ) : (
                  <Square size={18} />
                )}
              </button>
              <div className="flex-1">
                <ItemCard item={item} locationName={locationName(item)} onClick={() => navigate(`/items/${item.id}`)} />
              </div>
              <button
                onClick={() => {
                  if (confirm(`Delete "${item.name}"?`)) deleteItem(item.id)
                }}
                className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 text-xs px-2 py-1 bg-red-500/15 text-red-400 rounded hover:bg-red-500/25 transition-all"
              >
                Delete
              </button>
            </div>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <Package size={40} className="mx-auto mb-3 opacity-50" />
            <p>No items in this category</p>
          </div>
        )}
      </div>
    )
  }

  // Category overview — main landing view
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inventory</h1>
          <p className="text-slate-500 text-sm mt-1">
            {items.length} items &middot; ${totalValue.toLocaleString()} total value
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

      {/* All Items button */}
      <button
        onClick={() => setActiveCategory('all')}
        className="w-full flex items-center justify-between p-4 bg-slate-800/60 rounded-xl border border-slate-700 hover:border-blue-500/50 hover:shadow-sm transition-all"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-500/15 rounded-lg flex items-center justify-center">
            <LayoutGrid size={20} className="text-blue-400" />
          </div>
          <div className="text-left">
            <p className="font-medium text-sm">All Items</p>
            <p className="text-xs text-slate-500">{items.length} items &middot; ${totalValue.toLocaleString()}</p>
          </div>
        </div>
        <ChevronRight size={18} className="text-slate-400" />
      </button>

      {/* Category grid */}
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Browse by Category</h2>
        <div className="grid grid-cols-2 gap-3">
          {CATEGORIES.map((cat) => {
            const CatIcon = cat.icon
            const info = categoryCounts[cat.key] || { count: 0, value: 0 }
            return (
              <button
                key={cat.key}
                onClick={() => setActiveCategory(cat.key)}
                className={`flex flex-col p-4 rounded-xl border transition-all hover:shadow-sm text-left ${cat.bg}`}
              >
                <CatIcon size={24} className={cat.color} />
                <p className="font-medium text-sm mt-2 capitalize">{cat.label}</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {info.count} item{info.count !== 1 ? 's' : ''}
                </p>
                <p className="text-xs font-medium text-slate-600 mt-0.5">
                  ${info.value.toLocaleString()}
                </p>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
