import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Warehouse, Package } from 'lucide-react'
import { useStorageUnits } from '../hooks/useStorageUnits'
import { useItems } from '../hooks/useItems'
import ItemCard from '../components/ItemCard'

export default function StorageUnitDetail() {
  const { id } = useParams<{ id: string }>()
  const { units, loading: unitsLoading } = useStorageUnits()
  const { items, loading: itemsLoading } = useItems()

  const unit = units.find((u) => u.id === id)
  const unitItems = items.filter((i) => i.current_storage_id === id)
  const totalValue = unitItems.reduce((sum, i) => sum + i.value, 0)
  const loading = unitsLoading || itemsLoading

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (!unit) {
    return (
      <div className="text-center py-12">
        <p className="text-slate-500">Storage unit not found</p>
        <Link to="/storage" className="text-blue-600 text-sm mt-2 inline-block">Back to storage units</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link
        to="/storage"
        className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft size={16} />
        Back to storage units
      </Link>

      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-amber-50 rounded-lg">
            <Warehouse size={24} className="text-amber-700" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold">{unit.name}</h1>
            <p className="text-slate-500 text-sm">{unit.address}</p>
            {unit.unit_number && (
              <p className="text-slate-400 text-sm">Unit {unit.unit_number}</p>
            )}
            <div className="flex items-center gap-4 mt-3 text-sm text-slate-600">
              {unit.size && <span>Size: {unit.size}</span>}
              <span>${unit.monthly_cost}/mo</span>
            </div>
            {unit.notes && (
              <p className="mt-3 text-sm text-slate-500">{unit.notes}</p>
            )}
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Package size={18} />
            Stored Items ({unitItems.length})
          </h2>
          <span className="text-sm font-medium text-slate-600">
            Total: ${totalValue.toLocaleString()}
          </span>
        </div>

        {unitItems.length > 0 ? (
          <div className="space-y-2">
            {unitItems.map((item) => (
              <ItemCard key={item.id} item={item} locationName={unit.name} />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
            <Package size={36} className="mx-auto text-slate-300 mb-2" />
            <p className="text-slate-400 text-sm">No items in this storage unit</p>
            <Link
              to="/add-item"
              className="text-blue-600 text-sm mt-2 inline-block hover:text-blue-700"
            >
              Add a new item
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
