import { useState, useMemo } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import { useDroppable, useDraggable } from '@dnd-kit/core'
import { Link } from 'react-router-dom'
import { Package, Home, Warehouse, ArrowRightLeft, Search, Receipt } from 'lucide-react'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import { useStorageUnits } from '../hooks/useStorageUnits'
import type { Item } from '../lib/database.types'

function DraggableItem({ item }: { item: Item }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: item.id,
    data: { item },
  })

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`flex items-center gap-3 p-3 bg-white rounded-lg border border-slate-200 cursor-grab active:cursor-grabbing select-none transition-shadow ${
        isDragging ? 'opacity-50 shadow-lg' : 'hover:shadow-sm hover:border-blue-300'
      }`}
    >
      <div className="w-8 h-8 bg-slate-100 rounded flex items-center justify-center flex-shrink-0">
        <Package size={14} className="text-slate-500" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{item.name}</p>
        <p className="text-xs text-slate-400 capitalize">{item.category}</p>
      </div>
      <span className="text-xs font-medium text-slate-600 flex-shrink-0">
        ${item.value.toLocaleString()}
      </span>
    </div>
  )
}

function DroppableZone({
  id,
  label,
  icon,
  items,
  isOver,
  totalValue,
}: {
  id: string
  label: string
  icon: React.ReactNode
  items: Item[]
  isOver: boolean
  totalValue: number
}) {
  const { setNodeRef } = useDroppable({ id })

  return (
    <div
      ref={setNodeRef}
      className={`bg-white rounded-xl border-2 transition-colors min-h-[200px] ${
        isOver ? 'border-blue-400 bg-blue-50/50' : 'border-slate-200'
      }`}
    >
      <div className="p-4 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <h3 className="text-sm font-semibold">{label}</h3>
            <p className="text-xs text-slate-400">{items.length} items</p>
          </div>
        </div>
        <span className="text-xs font-medium text-slate-600">
          ${totalValue.toLocaleString()}
        </span>
      </div>
      <div className="p-3 space-y-2">
        {items.map((item) => (
          <DraggableItem key={item.id} item={item} />
        ))}
        {items.length === 0 && (
          <div className="py-8 text-center text-slate-300 text-sm">
            {isOver ? 'Drop here!' : 'Drop items here'}
          </div>
        )}
      </div>
    </div>
  )
}

export default function StagingPlanner() {
  const { items, moveItem } = useItems()
  const { properties } = useProperties()
  const { units } = useStorageUnits()

  const [activeItem, setActiveItem] = useState<Item | null>(null)
  const [selectedPropertyId, setSelectedPropertyId] = useState<string>(properties[0]?.id || '')
  const [search, setSearch] = useState('')
  const [overZone, setOverZone] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  // Update selected property when properties load
  if (!selectedPropertyId && properties.length > 0) {
    setSelectedPropertyId(properties[0].id)
  }

  const selectedProperty = properties.find((p) => p.id === selectedPropertyId)

  const availableItems = useMemo(() => {
    let available = items.filter((i) => i.status === 'available' || i.current_location_type === 'storage')
    if (search) {
      const q = search.toLowerCase()
      available = available.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q),
      )
    }
    return available
  }, [items, search])

  const propertyItems = useMemo(
    () => items.filter((i) => i.current_property_id === selectedPropertyId),
    [items, selectedPropertyId],
  )

  const handleDragStart = (event: DragStartEvent) => {
    const item = items.find((i) => i.id === event.active.id)
    setActiveItem(item || null)
  }

  const handleDragOver = (event: DragOverEvent) => {
    setOverZone(event.over?.id != null ? String(event.over.id) : null)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveItem(null)
    setOverZone(null)

    const { active, over } = event
    if (!over) return

    const itemId = String(active.id)
    const targetZone = String(over.id)

    const item = items.find((i) => i.id === itemId)
    if (!item) return

    if (targetZone === 'property-zone' && selectedPropertyId) {
      // Moving to the selected property
      if (item.current_property_id !== selectedPropertyId) {
        await moveItem(itemId, 'property', selectedPropertyId)
      }
    } else if (targetZone === 'available-zone') {
      // Moving back to the item's original storage or first available storage
      const storageId = item.current_storage_id || units[0]?.id
      if (storageId && item.current_location_type !== 'storage') {
        await moveItem(itemId, 'storage', storageId)
      }
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ArrowRightLeft size={24} />
            Staging Planner
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Drag items between available inventory and properties
          </p>
        </div>
        <Link
          to="/scan-receipt"
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
        >
          <Receipt size={16} />
          Scan Receipt
        </Link>
      </div>

      {/* Property selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-slate-700">Target Property:</label>
        <select
          value={selectedPropertyId}
          onChange={(e) => setSelectedPropertyId(e.target.value)}
          className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          {properties.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Available inventory */}
          <div>
            <div className="mb-3 flex items-center gap-3">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <Warehouse size={16} className="text-amber-600" />
                Available Inventory
              </h2>
              <div className="flex-1 relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter..."
                  className="w-full pl-8 pr-3 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <DroppableZone
              id="available-zone"
              label="Storage / Available Items"
              icon={<Warehouse size={16} className="text-amber-600" />}
              items={availableItems}
              isOver={overZone === 'available-zone'}
              totalValue={availableItems.reduce((s, i) => s + i.value, 0)}
            />
          </div>

          {/* Right: Property */}
          <div>
            <div className="mb-3">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <Home size={16} className="text-blue-600" />
                {selectedProperty?.name || 'Select a Property'}
              </h2>
            </div>
            <DroppableZone
              id="property-zone"
              label={selectedProperty?.name || 'Property'}
              icon={<Home size={16} className="text-blue-600" />}
              items={propertyItems}
              isOver={overZone === 'property-zone'}
              totalValue={propertyItems.reduce((s, i) => s + i.value, 0)}
            />
          </div>
        </div>

        {/* Drag overlay */}
        <DragOverlay>
          {activeItem ? (
            <div className="flex items-center gap-3 p-3 bg-white rounded-lg border-2 border-blue-400 shadow-xl cursor-grabbing w-72">
              <div className="w-8 h-8 bg-blue-100 rounded flex items-center justify-center flex-shrink-0">
                <Package size={14} className="text-blue-600" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{activeItem.name}</p>
                <p className="text-xs text-slate-400 capitalize">{activeItem.category}</p>
              </div>
              <span className="text-xs font-medium text-blue-600">
                ${activeItem.value.toLocaleString()}
              </span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
