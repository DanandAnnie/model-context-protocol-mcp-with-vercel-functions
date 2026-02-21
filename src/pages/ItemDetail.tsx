import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Package, Save, Trash2, Check, AlertTriangle } from 'lucide-react'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import { useStorageUnits } from '../hooks/useStorageUnits'
import PhotoCapture from '../components/PhotoCapture'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import type { ItemInsert, ItemCategory, ItemCondition, ItemStatus, LocationType, PaymentMethod } from '../lib/database.types'

const PAYMENT_METHODS: { key: PaymentMethod; label: string }[] = [
  { key: 'credit_card', label: 'Credit Card' },
  { key: 'debit_card', label: 'Debit Card' },
  { key: 'venmo', label: 'Venmo' },
  { key: 'zelle', label: 'Zelle' },
  { key: 'paypal', label: 'PayPal' },
  { key: 'cash', label: 'Cash' },
  { key: 'check', label: 'Check' },
  { key: 'other', label: 'Other' },
]

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

const CATEGORIES: ItemCategory[] = [
  'kitchen & dining', 'bedroom', 'living room', 'office',
  'bathroom', 'outdoor', 'other',
]

export default function ItemDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { items, loading, updateItem, deleteItem } = useItems()
  const { properties } = useProperties()
  const { units } = useStorageUnits()

  const item = items.find((i) => i.id === id)

  const [form, setForm] = useState<ItemInsert | null>(null)
  const [photo, setPhoto] = useState<File | null>(null)
  const [currentImage, setCurrentImage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Load item into form when found
  useEffect(() => {
    if (!item) return
    setForm({
      name: item.name,
      category: item.category,
      subcategory: item.subcategory,
      value: item.value,
      purchase_price: item.purchase_price ?? item.value,
      purchase_date: item.purchase_date ?? item.date_acquired,
      payment_method: item.payment_method ?? 'other',
      receipt_url: item.receipt_url ?? '',
      useful_life_years: item.useful_life_years ?? 7,
      condition: item.condition,
      date_acquired: item.date_acquired,
      notes: item.notes,
      photo_url: item.photo_url || '',
      current_location_type: item.current_location_type,
      current_storage_id: item.current_storage_id,
      current_property_id: item.current_property_id,
      status: item.status,
    })

    // Load existing image: prefer photo_url stored on item, fall back to Supabase item_images
    if (item.photo_url) {
      setCurrentImage(item.photo_url)
    } else if (isSupabaseConfigured()) {
      supabase
        .from('item_images')
        .select('image_url')
        .eq('item_id', item.id)
        .eq('is_primary', true)
        .maybeSingle()
        .then(({ data }) => {
          if (data?.image_url) setCurrentImage(data.image_url)
        })
    }
  }, [item])

  const handleLocationTypeChange = (locType: LocationType) => {
    if (!form) return
    setForm({
      ...form,
      current_location_type: locType,
      current_storage_id: locType === 'storage' ? (units[0]?.id ?? null) : null,
      current_property_id: locType === 'property' ? (properties[0]?.id ?? null) : null,
      status: locType === 'property' ? 'staged' : 'available',
    })
  }

  const handleSave = async () => {
    if (!form || !id) return
    setSaving(true)
    try {
      // Convert photo to base64 and store in photo_url
      let updatedForm = { ...form }
      if (photo) {
        const base64 = await fileToBase64(photo)
        updatedForm = { ...updatedForm, photo_url: base64 }
      }

      await updateItem(id, updatedForm)

      // Also upload to Supabase Storage if configured
      if (photo && isSupabaseConfigured()) {
        const ext = photo.name.split('.').pop()
        const path = `${id}/primary.${ext}`

        await supabase.storage.from('item-images').remove([path])

        const { error: uploadErr } = await supabase.storage
          .from('item-images')
          .upload(path, photo, { upsert: true })

        if (!uploadErr) {
          const { data: urlData } = supabase.storage
            .from('item-images')
            .getPublicUrl(path)

          const { data: existing } = await supabase
            .from('item_images')
            .select('id')
            .eq('item_id', id)
            .eq('is_primary', true)
            .maybeSingle()

          if (existing) {
            await supabase
              .from('item_images')
              .update({ image_url: urlData.publicUrl })
              .eq('id', existing.id)
          } else {
            await supabase.from('item_images').insert({
              item_id: id,
              image_url: urlData.publicUrl,
              is_primary: true,
            })
          }
        }
      }

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
      await deleteItem(id)
      navigate('/inventory')
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

  if (!item || !form) {
    return (
      <div className="text-center py-12">
        <Package size={40} className="mx-auto text-slate-300 mb-3" />
        <p className="text-slate-500">Item not found</p>
        <Link to="/inventory" className="text-blue-600 text-sm mt-2 inline-block">Back to inventory</Link>
      </div>
    )
  }

  const locationName =
    item.current_location_type === 'property'
      ? properties.find((p) => p.id === item.current_property_id)?.name
      : units.find((u) => u.id === item.current_storage_id)?.name

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <Link
          to="/inventory"
          className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft size={16} />
          Back to inventory
        </Link>
        <button
          onClick={() => setDeleteConfirm(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        >
          <Trash2 size={14} />
          Delete
        </button>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-3 bg-blue-50 rounded-lg">
          <Package size={24} className="text-blue-700" />
        </div>
        <div>
          <h1 className="text-xl font-bold">{item.name}</h1>
          <p className="text-sm text-slate-500 capitalize">
            {item.category} {locationName && `· ${locationName}`}
          </p>
        </div>
      </div>

      {/* Photo */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-2">Photo</label>
        <PhotoCapture onCapture={setPhoto} currentImage={currentImage} />
      </div>

      {/* Item details form */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700">Item Details</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Category</label>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value as ItemCategory })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c} className="capitalize">{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Subcategory</label>
            <input
              value={form.subcategory}
              onChange={(e) => setForm({ ...form, subcategory: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Value ($)</label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={form.value}
              onChange={(e) => setForm({ ...form, value: +e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Condition</label>
            <select
              value={form.condition}
              onChange={(e) => setForm({ ...form, condition: e.target.value as ItemCondition })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="excellent">Excellent</option>
              <option value="good">Good</option>
              <option value="fair">Fair</option>
              <option value="poor">Poor</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Date Acquired</label>
            <input
              type="date"
              value={form.date_acquired || ''}
              onChange={(e) => setForm({ ...form, date_acquired: e.target.value || null })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as ItemStatus })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="available">Available</option>
              <option value="staged">Staged</option>
              <option value="damaged">Damaged</option>
              <option value="retired">Retired</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Purchase & Tax Info */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700">Purchase & Tax Info</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Purchase Price ($)</label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={form.purchase_price}
              onChange={(e) => setForm({ ...form, purchase_price: +e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Purchase Date</label>
            <input
              type="date"
              value={form.purchase_date || ''}
              onChange={(e) => setForm({ ...form, purchase_date: e.target.value || null })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Payment Method</label>
            <select
              value={form.payment_method}
              onChange={(e) => setForm({ ...form, payment_method: e.target.value as PaymentMethod })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Useful Life (years)</label>
            <input
              type="number"
              min={1}
              max={40}
              value={form.useful_life_years}
              onChange={(e) => setForm({ ...form, useful_life_years: +e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="text-xs text-slate-400 mt-1">For depreciation (IRS default: 7 years)</p>
          </div>
        </div>
      </div>

      {/* Location */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700">Current Location</h2>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => handleLocationTypeChange('storage')}
            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium border transition-colors ${
              form.current_location_type === 'storage'
                ? 'bg-blue-50 border-blue-300 text-blue-700'
                : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
          >
            Storage Unit
          </button>
          <button
            type="button"
            onClick={() => handleLocationTypeChange('property')}
            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium border transition-colors ${
              form.current_location_type === 'property'
                ? 'bg-blue-50 border-blue-300 text-blue-700'
                : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
          >
            Property
          </button>
        </div>

        {form.current_location_type === 'storage' && (
          <select
            value={form.current_storage_id || ''}
            onChange={(e) => setForm({ ...form, current_storage_id: e.target.value || null })}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">Select storage unit...</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} {u.unit_number ? `(${u.unit_number})` : ''}
              </option>
            ))}
          </select>
        )}

        {form.current_location_type === 'property' && (
          <select
            value={form.current_property_id || ''}
            onChange={(e) => setForm({ ...form, current_property_id: e.target.value || null })}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">Select property...</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
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
                <h3 className="font-semibold text-slate-900">Delete Item</h3>
                <p className="text-sm text-slate-500 mt-0.5">This action cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm text-slate-600">
              Are you sure you want to delete <span className="font-medium">{item.name}</span>?
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
