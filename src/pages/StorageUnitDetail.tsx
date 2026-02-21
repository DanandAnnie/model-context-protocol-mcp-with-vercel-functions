import { useState, useEffect, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Warehouse, Package, Save, Trash2, Check, AlertTriangle, Camera, Upload, X, Image as ImageIcon } from 'lucide-react'
import { useStorageUnits } from '../hooks/useStorageUnits'
import { useItems } from '../hooks/useItems'
import ItemCard from '../components/ItemCard'
import type { StorageUnitInsert } from '../lib/database.types'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function StorageUnitDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { units, loading: unitsLoading, updateUnit, deleteUnit } = useStorageUnits()
  const { items, loading: itemsLoading } = useItems()

  const unit = units.find((u) => u.id === id)
  const unitItems = items.filter((i) => i.current_storage_id === id)
  const totalValue = unitItems.reduce((sum, i) => sum + i.value, 0)
  const loading = unitsLoading || itemsLoading

  const [form, setForm] = useState<StorageUnitInsert | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  // Load unit into form
  useEffect(() => {
    if (!unit) return
    setForm({
      name: unit.name,
      address: unit.address,
      unit_number: unit.unit_number,
      size: unit.size,
      monthly_cost: unit.monthly_cost,
      notes: unit.notes,
      photo_url: unit.photo_url || '',
    })
    if (unit.photo_url) {
      setPhotoPreview(unit.photo_url)
    }
  }, [unit])

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !form) return
    const base64 = await fileToBase64(file)
    setPhotoPreview(base64)
    setForm({ ...form, photo_url: base64 })
    e.target.value = ''
  }

  const clearPhoto = () => {
    if (!form) return
    setPhotoPreview(null)
    setForm({ ...form, photo_url: '' })
  }

  const handleSave = async () => {
    if (!form || !id) return
    setSaving(true)
    try {
      await updateUnit(id, form)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      alert('Failed to save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!id) return
    setDeleting(true)
    try {
      await deleteUnit(id)
      navigate('/storage')
    } finally {
      setDeleting(false)
      setDeleteConfirm(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (!unit || !form) {
    return (
      <div className="text-center py-12">
        <p className="text-slate-500">Storage unit not found</p>
        <Link to="/storage" className="text-blue-600 text-sm mt-2 inline-block">Back to storage units</Link>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <Link
          to="/storage"
          className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft size={16} />
          Back to storage units
        </Link>
        <button
          onClick={() => setDeleteConfirm(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        >
          <Trash2 size={14} />
          Delete
        </button>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handlePhotoSelect}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handlePhotoSelect}
      />

      {/* Storage Unit Photo */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-2">Unit Photo</label>
        {photoPreview ? (
          <div className="relative rounded-xl overflow-hidden">
            <img src={photoPreview} alt="Storage unit" className="w-full aspect-video object-cover" />
            <button
              type="button"
              onClick={clearPhoto}
              className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center">
            <ImageIcon size={40} className="mx-auto text-slate-300 mb-3" />
            <p className="text-sm text-slate-500 mb-4">Add a photo of this storage unit</p>
            <div className="flex justify-center gap-3">
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
              >
                <Camera size={16} />
                Take Photo
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-700 text-sm rounded-lg hover:bg-slate-200"
              >
                <Upload size={16} />
                Upload
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Edit form */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Warehouse size={16} className="text-amber-700" />
          Unit Details
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Address</label>
            <input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {saving ? (
          <>
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
            Saving...
          </>
        ) : saved ? (
          <>
            <Check size={18} />
            Saved!
          </>
        ) : (
          <>
            <Save size={18} />
            Save Changes
          </>
        )}
      </button>

      {/* Stored items */}
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
              <ItemCard key={item.id} item={item} locationName={unit.name} onClick={() => navigate(`/items/${item.id}`)} />
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

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => !deleting && setDeleteConfirm(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-red-50 rounded-full">
                <AlertTriangle size={20} className="text-red-500" />
              </div>
              <div>
                <h3 className="font-semibold text-slate-900">Delete Storage Unit</h3>
                <p className="text-sm text-slate-500 mt-0.5">This action cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm text-slate-600">
              Are you sure you want to delete <span className="font-medium">{unit.name}</span>?
            </p>
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => setDeleteConfirm(false)}
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
