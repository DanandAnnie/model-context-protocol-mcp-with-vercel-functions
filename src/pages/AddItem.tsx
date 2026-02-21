import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PlusCircle, Check, Loader2, Sparkles } from 'lucide-react'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import { useStorageUnits } from '../hooks/useStorageUnits'
import PhotoCapture from '../components/PhotoCapture'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { isAIConfigured, identifyItemsFromImage } from '../lib/ai'
import type { ItemInsert, ItemCategory, ItemCondition, ItemStatus, LocationType, PaymentMethod } from '../lib/database.types'

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

const PAYMENT_METHODS: { key: PaymentMethod; label: string }[] = [
  { key: 'square', label: 'Square' },
  { key: 'credit_card', label: 'Credit Card' },
  { key: 'debit_card', label: 'Debit Card' },
  { key: 'venmo', label: 'Venmo' },
  { key: 'zelle', label: 'Zelle' },
  { key: 'paypal', label: 'PayPal' },
  { key: 'cash', label: 'Cash' },
  { key: 'check', label: 'Check' },
  { key: 'other', label: 'Other' },
]

const emptyForm: ItemInsert = {
  name: '', category: 'living room', subcategory: '', value: 0,
  purchase_price: 0, purchase_date: null, payment_method: 'other',
  receipt_url: '', useful_life_years: 7,
  condition: 'good', date_acquired: null, notes: '', photo_url: '',
  current_location_type: 'storage', current_storage_id: null,
  current_property_id: null, status: 'available',
}

export default function AddItem() {
  const navigate = useNavigate()
  const { addItem } = useItems()
  const { properties } = useProperties()
  const { units } = useStorageUnits()

  const [form, setForm] = useState<ItemInsert>(emptyForm)
  const [photo, setPhoto] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [aiIdentifying, setAiIdentifying] = useState(false)
  const [aiResult, setAiResult] = useState<'success' | 'error' | null>(null)

  const handlePhotoCapture = async (file: File) => {
    setPhoto(file)
    setAiResult(null)

    // Auto-identify with AI if configured
    if (!isAIConfigured()) return

    setAiIdentifying(true)
    try {
      const base64 = await fileToBase64(file)
      const items = await identifyItemsFromImage(base64)
      if (items.length > 0) {
        const item = items[0] // Use the first (primary) identified item
        setForm((prev) => ({
          ...prev,
          name: item.name,
          category: item.category,
          value: item.estimated_value,
          purchase_price: item.estimated_value,
          condition: item.condition,
        }))
        setAiResult('success')
      }
    } catch {
      setAiResult('error')
    } finally {
      setAiIdentifying(false)
    }
  }

  const handleLocationTypeChange = (locType: LocationType) => {
    setForm({
      ...form,
      current_location_type: locType,
      current_storage_id: locType === 'storage' ? (units[0]?.id ?? null) : null,
      current_property_id: locType === 'property' ? (properties[0]?.id ?? null) : null,
      status: locType === 'property' ? 'staged' : 'available',
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)

    try {
      // Convert photo to base64 and include in the item data
      let formWithPhoto = { ...form }
      if (photo) {
        const base64 = await fileToBase64(photo)
        formWithPhoto = { ...formWithPhoto, photo_url: base64 }
      }

      const item = await addItem(formWithPhoto)

      // Also upload to Supabase Storage if configured
      if (photo && isSupabaseConfigured() && item) {
        const ext = photo.name.split('.').pop()
        const path = `${item.id}/primary.${ext}`
        const { error: uploadErr } = await supabase.storage
          .from('item-images')
          .upload(path, photo)

        if (!uploadErr) {
          const { data: urlData } = supabase.storage
            .from('item-images')
            .getPublicUrl(path)

          await supabase.from('item_images').insert({
            item_id: item.id,
            image_url: urlData.publicUrl,
            is_primary: true,
          })
        }
      }

      setSaved(true)
      setTimeout(() => {
        navigate('/inventory')
      }, 1200)
    } catch {
      alert('Failed to save item. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  if (saved) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-green-600">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
          <Check size={32} />
        </div>
        <p className="text-lg font-medium">Item Added!</p>
        <p className="text-sm text-slate-500 mt-1">Redirecting to inventory...</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <PlusCircle size={24} />
          Add New Item
        </h1>
        <p className="text-slate-500 text-sm mt-1">Add an item to your staging inventory</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Photo capture */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Photo</label>
          <PhotoCapture onCapture={handlePhotoCapture} />
          {aiIdentifying && (
            <div className="mt-3 flex items-center gap-2 text-purple-600 bg-purple-50 rounded-lg px-4 py-2.5">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm font-medium">AI is identifying this item...</span>
            </div>
          )}
          {aiResult === 'success' && !aiIdentifying && (
            <div className="mt-3 flex items-center gap-2 text-green-700 bg-green-50 rounded-lg px-4 py-2.5">
              <Sparkles size={16} />
              <span className="text-sm font-medium">AI identified the item and filled in the details below. Review and adjust as needed.</span>
            </div>
          )}
          {aiResult === 'error' && !aiIdentifying && (
            <div className="mt-3 text-sm text-amber-700 bg-amber-50 rounded-lg px-4 py-2.5">
              AI couldn&apos;t identify this item. Fill in the details manually.
            </div>
          )}
        </div>

        {/* Basic info */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-700">Item Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="e.g. Mid-Century Sofa"
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
                placeholder="e.g. seating, tables"
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
                rows={2}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Description, dimensions, etc."
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
              <p className="text-xs text-slate-400 mt-1">For depreciation calculation (IRS default: 7 years)</p>
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

        <button
          type="submit"
          disabled={saving}
          className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Add Item'}
        </button>
      </form>
    </div>
  )
}
