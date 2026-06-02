import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Warehouse, Plus, X, DollarSign, Ruler } from 'lucide-react'
import { useStorageUnits } from '../hooks/useStorageUnits'
import { useItems } from '../hooks/useItems'
import type { StorageUnitInsert } from '../lib/database.types'

const emptyForm: StorageUnitInsert = {
  name: '', address: '', unit_number: '', size: '',
  monthly_cost: 0, notes: '', photo_url: '',
}

export default function StorageUnits() {
  const { units, loading, addUnit, deleteUnit } = useStorageUnits()
  const { items } = useItems()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<StorageUnitInsert>(emptyForm)

  const itemCount = (unitId: string) =>
    items.filter((i) => i.current_storage_id === unitId).length

  const storedValue = (unitId: string) =>
    items
      .filter((i) => i.current_storage_id === unitId)
      .reduce((sum, i) => sum + i.value, 0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await addUnit(form)
    setForm(emptyForm)
    setShowForm(false)
  }

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
          <h1 className="text-2xl font-bold">Storage Units</h1>
          <p className="text-slate-500 text-sm mt-1">{units.length} units</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
        >
          {showForm ? <X size={16} /> : <Plus size={16} />}
          {showForm ? 'Cancel' : 'Add Unit'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Facility name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Address</label>
              <input
                required
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Street address"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Unit #</label>
              <input
                value={form.unit_number}
                onChange={(e) => setForm({ ...form, unit_number: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="e.g. A-12"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Size</label>
              <input
                value={form.size}
                onChange={(e) => setForm({ ...form, size: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="e.g. 10x20"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Monthly Cost ($)</label>
              <input
                type="number"
                min={0}
                step={0.01}
                value={form.monthly_cost}
                onChange={(e) => setForm({ ...form, monthly_cost: +e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
              <input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Optional notes"
              />
            </div>
          </div>
          <button
            type="submit"
            className="px-5 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
          >
            Save Unit
          </button>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {units.map((unit) => (
          <Link
            key={unit.id}
            to={`/storage/${unit.id}`}
            className="bg-white rounded-xl border border-slate-200 hover:shadow-md hover:border-blue-300 transition-all group overflow-hidden"
          >
            {unit.photo_url ? (
              <div className="h-36 overflow-hidden">
                <img src={unit.photo_url} alt={unit.name} className="w-full h-full object-cover" />
              </div>
            ) : null}
            <div className="p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  {!unit.photo_url && (
                    <div className="p-2.5 bg-amber-50 rounded-lg group-hover:bg-amber-100 transition-colors">
                      <Warehouse size={18} className="text-amber-400" />
                    </div>
                  )}
                  <div>
                    <h3 className="font-semibold">{unit.name}</h3>
                    <p className="text-xs text-slate-500">{unit.address}</p>
                    {unit.unit_number && (
                      <p className="text-xs text-slate-400">Unit {unit.unit_number}</p>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    if (confirm('Delete this storage unit?')) deleteUnit(unit.id)
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-500 transition-all"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="mt-4 flex items-center gap-4 text-xs text-slate-500">
                {unit.size && (
                  <span className="flex items-center gap-1"><Ruler size={12} />{unit.size}</span>
                )}
                <span className="flex items-center gap-1">
                  <DollarSign size={12} />${unit.monthly_cost}/mo
                </span>
              </div>
              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                <span className="text-slate-500">{itemCount(unit.id)} items stored</span>
                <span className="font-medium text-slate-700">${storedValue(unit.id).toLocaleString()}</span>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {units.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <Warehouse size={40} className="mx-auto mb-3 opacity-50" />
          <p>No storage units yet. Add your first one above.</p>
        </div>
      )}
    </div>
  )
}
