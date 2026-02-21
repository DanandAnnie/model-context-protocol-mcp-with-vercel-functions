import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Home, Plus, Bed, Bath, Maximize, Trash2, X, Check, AlertTriangle, Video, Camera } from 'lucide-react'
import { useProperties } from '../hooks/useProperties'
import { useItems } from '../hooks/useItems'
import type { PropertyInsert, PropertyType } from '../lib/database.types'

const emptyForm: PropertyInsert = {
  name: '', address: '', city: '', bedrooms: 0, bathrooms: 0,
  sqft: 0, property_type: 'house', notes: '', photo_url: '',
}

export default function Properties() {
  const { properties, loading, addProperty, deleteProperty } = useProperties()
  const { items } = useItems()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<PropertyInsert>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showTimelapse, setShowTimelapse] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)

  const itemCount = (propId: string) =>
    items.filter((i) => i.current_property_id === propId).length

  const stagedValue = (propId: string) =>
    items
      .filter((i) => i.current_property_id === propId)
      .reduce((sum, i) => sum + i.value, 0)

  const canSave = form.name.trim().length > 0 && form.address.trim().length > 0

  // Autosave: when required fields are filled, save after a short debounce
  const doAutosave = useCallback(async (formData: PropertyInsert) => {
    if (formData.name.trim().length === 0 || formData.address.trim().length === 0) return
    setSaving(true)
    try {
      await addProperty(formData)
      setSaved(true)
      const propName = formData.name
      setTimeout(() => {
        setSaved(false)
        setForm(emptyForm)
        setShowForm(false)
        setShowTimelapse(propName)
      }, 1200)
    } finally {
      setSaving(false)
    }
  }, [addProperty])

  useEffect(() => {
    if (!showForm || !canSave) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      doAutosave(form)
    }, 1500)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [form, canSave, showForm, doAutosave])

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteProperty(deleteTarget.id)
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
    }
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
          onClick={() => { setShowForm(!showForm); setSaved(false) }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
        >
          {showForm ? <X size={16} /> : <Plus size={16} />}
          {showForm ? 'Cancel' : 'Add Property'}
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">New Property</h2>
            {saving && (
              <span className="flex items-center gap-1.5 text-xs text-blue-600">
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-600" />
                Saving...
              </span>
            )}
            {saved && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-600">
                <Check size={12} />
                Saved!
              </span>
            )}
            {!saving && !saved && canSave && (
              <span className="text-xs text-slate-400">Auto-saves when ready</span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
              <input
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
              <label className="block text-sm font-medium text-slate-700 mb-1">Address *</label>
              <input
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
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {properties.map((prop) => (
          <div key={prop.id} className="bg-white rounded-xl border border-slate-200 hover:shadow-md hover:border-blue-300 transition-all group relative overflow-hidden">
            <Link
              to={`/properties/${prop.id}`}
              className="block"
            >
              {prop.photo_url ? (
                <div className="h-36 overflow-hidden">
                  <img src={prop.photo_url} alt={prop.name} className="w-full h-full object-cover" />
                </div>
              ) : null}
              <div className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    {!prop.photo_url && (
                      <div className="p-2.5 bg-blue-50 rounded-lg group-hover:bg-blue-100 transition-colors">
                        <Home size={18} className="text-blue-700" />
                      </div>
                    )}
                    <div>
                      <h3 className="font-semibold">{prop.name}</h3>
                      <p className="text-xs text-slate-500">{prop.address}</p>
                      {prop.city && <p className="text-xs text-slate-400">{prop.city}</p>}
                    </div>
                  </div>
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
              </div>
            </Link>
            <button
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDeleteTarget({ id: prop.id, name: prop.name })
              }}
              className="absolute top-3 right-3 z-10 p-2.5 rounded-lg bg-white/80 hover:bg-red-50 text-slate-400 hover:text-red-500 transition-all shadow-sm"
              title="Delete property"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      {properties.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <Home size={40} className="mx-auto mb-3 opacity-50" />
          <p>No properties yet. Add your first one above.</p>
        </div>
      )}

      {/* Hidden video input for timelapse recording */}
      <input
        ref={videoInputRef}
        type="file"
        accept="video/*"
        capture="environment"
        className="hidden"
        onChange={() => {
          setShowTimelapse(null)
        }}
      />

      {/* Timelapse reminder popup */}
      {showTimelapse && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setShowTimelapse(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-50 rounded-full">
                <Video size={24} className="text-blue-600" />
              </div>
              <div>
                <h3 className="font-semibold text-slate-900">Create a Timelapse?</h3>
                <p className="text-sm text-slate-500 mt-0.5">
                  <span className="font-medium">{showTimelapse}</span> was added!
                </p>
              </div>
            </div>
            <p className="text-sm text-slate-600">
              Record a timelapse video of the staging setup at this property.
              This helps track before/after transformations for your portfolio.
            </p>
            <div className="flex flex-col gap-2.5 pt-2">
              <button
                onClick={() => videoInputRef.current?.click()}
                className="w-full px-4 py-3 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center justify-center gap-2"
              >
                <Camera size={18} />
                Open Camera for Timelapse
              </button>
              <button
                onClick={() => setShowTimelapse(null)}
                className="w-full px-4 py-2.5 text-sm font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                Maybe Later
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => !deleting && setDeleteTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-red-50 rounded-full">
                <AlertTriangle size={20} className="text-red-500" />
              </div>
              <div>
                <h3 className="font-semibold text-slate-900">Delete Property</h3>
                <p className="text-sm text-slate-500 mt-0.5">This action cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm text-slate-600">
              Are you sure you want to delete <span className="font-medium">{deleteTarget.name}</span>?
              Any items staged at this property will need to be reassigned.
            </p>
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {deleting ? (
                  <>
                    <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 size={14} />
                    Delete
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
