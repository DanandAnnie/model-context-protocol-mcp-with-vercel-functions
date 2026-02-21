import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Home, Plus, Bed, Bath, Maximize, X } from 'lucide-react'
import { useProperties } from '../hooks/useProperties'
import { useItems } from '../hooks/useItems'
import type { PropertyInsert, PropertyType } from '../lib/database.types'

const emptyForm: PropertyInsert = {
  name: '', address: '', city: '', bedrooms: 0, bathrooms: 0,
  sqft: 0, property_type: 'house', notes: '',
}

export default function Properties() {
  const { properties, loading, addProperty, deleteProperty } = useProperties()
  const { items } = useItems()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<PropertyInsert>(emptyForm)

  const itemCount = (propId: string) =>
    items.filter((i) => i.current_property_id === propId).length

  const stagedValue = (propId: string) =>
    items
      .filter((i) => i.current_property_id === propId)
      .reduce((sum, i) => sum + i.value, 0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await addProperty(form)
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
          <h1 className="text-2xl font-bold">Properties</h1>
          <p className="text-slate-500 text-sm mt-1">{properties.length} properties</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
        >
          {showForm ? <X size={16} /> : <Plus size={16} />}
          {showForm ? 'Cancel' : 'Add Property'}
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
                placeholder="Property name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Type</label>
              <select
                value={form.property_type}
                onChange={(e) => setForm({ ...form, property_type: e.target.value as PropertyType })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="house">House</option>
                <option value="condo">Condo</option>
                <option value="townhouse">Townhouse</option>
                <option value="apartment">Apartment</option>
                <option value="other">Other</option>
              </select>
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
              <label className="block text-sm font-medium text-slate-700 mb-1">City</label>
              <input
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="City"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Beds</label>
                <input
                  type="number"
                  min={0}
                  value={form.bedrooms}
                  onChange={(e) => setForm({ ...form, bedrooms: +e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Baths</label>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={form.bathrooms}
                  onChange={(e) => setForm({ ...form, bathrooms: +e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Sq Ft</label>
                <input
                  type="number"
                  min={0}
                  value={form.sqft}
                  onChange={(e) => setForm({ ...form, sqft: +e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
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
            Save Property
          </button>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {properties.map((prop) => (
          <Link
            key={prop.id}
            to={`/properties/${prop.id}`}
            className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-md hover:border-blue-300 transition-all group"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-blue-50 rounded-lg group-hover:bg-blue-100 transition-colors">
                  <Home size={18} className="text-blue-700" />
                </div>
                <div>
                  <h3 className="font-semibold">{prop.name}</h3>
                  <p className="text-xs text-slate-500">{prop.address}</p>
                  {prop.city && <p className="text-xs text-slate-400">{prop.city}</p>}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.preventDefault()
                  if (confirm('Delete this property?')) deleteProperty(prop.id)
                }}
                className="opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-500 transition-all"
              >
                <X size={14} />
              </button>
            </div>
            <div className="mt-4 flex items-center gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1"><Bed size={12} />{prop.bedrooms} bd</span>
              <span className="flex items-center gap-1"><Bath size={12} />{prop.bathrooms} ba</span>
              <span className="flex items-center gap-1"><Maximize size={12} />{prop.sqft.toLocaleString()} sqft</span>
            </div>
            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-slate-500">{itemCount(prop.id)} items staged</span>
              <span className="font-medium text-slate-700">${stagedValue(prop.id).toLocaleString()}</span>
            </div>
          </Link>
        ))}
      </div>

      {properties.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <Home size={40} className="mx-auto mb-3 opacity-50" />
          <p>No properties yet. Add your first one above.</p>
        </div>
      )}
    </div>
  )
}
