import { Package, MapPin } from 'lucide-react'
import type { Item } from '../lib/database.types'

interface ItemCardProps {
  item: Item
  locationName?: string
  compact?: boolean
  onClick?: () => void
}

const statusColors: Record<string, string> = {
  available: 'bg-green-100 text-green-800',
  staged: 'bg-blue-100 text-blue-800',
  damaged: 'bg-red-100 text-red-800',
  retired: 'bg-slate-100 text-slate-800',
}

const conditionColors: Record<string, string> = {
  excellent: 'text-green-600',
  good: 'text-blue-600',
  fair: 'text-amber-600',
  poor: 'text-red-600',
}

export default function ItemCard({ item, locationName, compact, onClick }: ItemCardProps) {
  if (compact) {
    return (
      <div
        className="flex items-center gap-3 p-3 bg-white rounded-lg border border-slate-200 hover:border-blue-300 hover:shadow-sm transition-all cursor-pointer"
        onClick={onClick}
      >
        <div className="w-8 h-8 bg-slate-100 rounded flex items-center justify-center flex-shrink-0">
          <Package size={14} className="text-slate-500" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{item.name}</p>
          <p className="text-xs text-slate-400">{item.category}</p>
        </div>
        <span className="text-xs font-medium text-slate-600">
          ${item.value.toLocaleString()}
        </span>
      </div>
    )
  }

  return (
    <div
      className="bg-white rounded-xl border border-slate-200 p-4 hover:shadow-md transition-shadow cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center flex-shrink-0">
            <Package size={18} className="text-slate-500" />
          </div>
          <div className="min-w-0">
            <h3 className="font-medium text-sm truncate">{item.name}</h3>
            <p className="text-xs text-slate-500 capitalize">{item.category}{item.subcategory ? ` / ${item.subcategory}` : ''}</p>
          </div>
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColors[item.status]}`}>
          {item.status}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs">
        <div className="flex items-center gap-3 text-slate-500">
          <span className={`font-medium ${conditionColors[item.condition]}`}>
            {item.condition}
          </span>
          {locationName && (
            <span className="flex items-center gap-1">
              <MapPin size={12} />
              {locationName}
            </span>
          )}
        </div>
        <span className="font-semibold text-slate-800">
          ${item.value.toLocaleString()}
        </span>
      </div>
    </div>
  )
}
