import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PlusCircle, Check, Loader2, Sparkles, Brain, Ruler, Camera, Search, Smartphone, X } from 'lucide-react'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import { useStorageUnits } from '../hooks/useStorageUnits'
import MultiPhotoCapture from '../components/MultiPhotoCapture'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { isAIConfigured, identifyItemsFromImage, measureItemFromImage, lookupDimensions, getMagicPlanLink, parseDimensionText } from '../lib/ai'
import { fileToBase64, saveAdditionalPhotos } from '../lib/photos'
import type { ItemInsert, ItemCategory, ItemCondition, ItemStatus, LocationType, PaymentMethod } from '../lib/database.types'

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
  length_inches: 0, width_inches: 0, height_inches: 0,
}

export default function AddItem() {
  const navigate = useNavigate()
  const { addItem } = useItems()
  const { properties } = useProperties()
  const { units } = useStorageUnits()

  const [form, setForm] = useState<ItemInsert>(emptyForm)
  const [photos, setPhotos] = useState<File[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [aiIdentifying, setAiIdentifying] = useState(false)
  const [aiResult, setAiResult] = useState<'success' | 'error' | 'no_key' | null>(null)
  const [aiErrorMsg, setAiErrorMsg] = useState('')
  const [aiMeasuring, setAiMeasuring] = useState(false)
  const [aiLookingUp, setAiLookingUp] = useState(false)
  const [aiMeasureResult, setAiMeasureResult] = useState<{ confidence: string; notes: string } | null>(null)
  const [aiMeasureError, setAiMeasureError] = useState('')
  const [showMagicPlanModal, setShowMagicPlanModal] = useState(false)
  const [magicPlanText, setMagicPlanText] = useState('')
  const [magicPlanError, setMagicPlanError] = useState('')

  const handleMagicPlanImport = () => {
    setMagicPlanError('')
    const dims = parseDimensionText(magicPlanText)
    if (!dims) {
      setMagicPlanError('Could not parse dimensions. Try format: 84 x 36 x 30')
      return
    }
    setForm((prev) => ({
      ...prev,
      length_inches: dims.length_inches,
      width_inches: dims.width_inches,
      height_inches: dims.height_inches,
    }))
    setAiMeasureResult({ confidence: dims.confidence, notes: dims.notes })
    setShowMagicPlanModal(false)
    setMagicPlanText('')
  }

  const handleLookupDimensions = async () => {
    if (!form.name) return
    setAiLookingUp(true)
    setAiMeasureResult(null)
    setAiMeasureError('')
    try {
      const dims = await lookupDimensions(form.name, form.category, form.subcategory)
      setForm((prev) => ({
        ...prev,
        length_inches: dims.length_inches,
        width_inches: dims.width_inches,
        height_inches: dims.height_inches,
      }))
      setAiMeasureResult({ confidence: dims.confidence, notes: dims.notes })
    } catch (err) {
      setAiMeasureError(err instanceof Error ? err.message : 'Lookup failed')
    } finally {
      setAiLookingUp(false)
    }
  }

  const handlePhotosChange = async (files: File[]) => {
    setPhotos(files)

    // Auto-identify from first photo if this is the first photo added
    if (files.length > 0 && photos.length === 0) {
      setAiResult(null)
      if (!isAIConfigured()) {
        setAiResult('no_key')
        return
      }

      setAiIdentifying(true)
      try {
        const base64 = await fileToBase64(files[0])
        const items = await identifyItemsFromImage(base64)
        if (items.length > 0) {
          const item = items[0]
          const today = new Date().toISOString().split('T')[0]
          setForm((prev) => ({
            ...prev,
            name: item.name,
            category: item.category,
            subcategory: item.subcategory,
            value: item.estimated_value,
            purchase_price: item.estimated_value,
            condition: item.condition,
            notes: item.description,
            useful_life_years: item.useful_life_years,
            date_acquired: today,
            purchase_date: today,
          }))
          setAiResult('success')
        }
      } catch (err) {
        setAiResult('error')
        setAiErrorMsg(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setAiIdentifying(false)
      }
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
      // Convert primary photo to base64 and include in the item data
      let formWithPhoto = { ...form }
      if (photos.length > 0) {
        const base64 = await fileToBase64(photos[0])
        formWithPhoto = { ...formWithPhoto, photo_url: base64 }
      }

      const item = await addItem(formWithPhoto)

      if (item) {
        // Save additional photos to localStorage
        if (photos.length > 1) {
          const additionalBase64 = await Promise.all(
            photos.slice(1).map((f) => fileToBase64(f))
          )
          saveAdditionalPhotos('item', item.id, additionalBase64)
        }

        // Also upload to Supabase Storage if configured
        if (photos.length > 0 && isSupabaseConfigured()) {
          for (let i = 0; i < photos.length; i++) {
            const ext = photos[i].name.split('.').pop()
            const path = i === 0
              ? `${item.id}/primary.${ext}`
              : `${item.id}/${crypto.randomUUID()}.${ext}`
            const { error: uploadErr } = await supabase.storage
              .from('item-images')
              .upload(path, photos[i])

            if (!uploadErr) {
              const { data: urlData } = supabase.storage
                .from('item-images')
                .getPublicUrl(path)

              await supabase.from('item_images').insert({
                item_id: item.id,
                image_url: urlData.publicUrl,
                is_primary: i === 0,
              })
            }
          }
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
      <div className="flex flex-col items-center justify-center h-64 text-green-400">
        <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mb-4">
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
          <MultiPhotoCapture onPhotosChange={handlePhotosChange} label="Item Photos" />
          {aiIdentifying && (
            <div className="mt-3 flex items-center gap-2 text-purple-400 bg-purple-500/10 rounded-lg px-4 py-2.5">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm font-medium">AI is identifying this item...</span>
            </div>
          )}
          {aiResult === 'success' && !aiIdentifying && (
            <div className="mt-3 flex items-center gap-2 text-green-400 bg-green-500/10 rounded-lg px-4 py-2.5">
              <Sparkles size={16} />
              <span className="text-sm font-medium">AI identified the item and filled in the details below. Review and adjust as needed.</span>
            </div>
          )}
          {aiResult === 'error' && !aiIdentifying && (
            <div className="mt-3 text-sm text-amber-400 bg-amber-500/10 rounded-lg px-4 py-2.5">
              <p>AI couldn&apos;t identify this item. Fill in the details manually.</p>
              {aiErrorMsg && <p className="mt-1 text-xs text-amber-300">{aiErrorMsg}</p>}
            </div>
          )}
          {aiResult === 'no_key' && (
            <div className="mt-3 flex items-center gap-2 text-purple-300 bg-purple-500/10 rounded-lg px-4 py-2.5">
              <Brain size={16} />
              <span className="text-sm">
                Add your Anthropic API key in{' '}
                <button
                  type="button"
                  onClick={() => navigate('/settings')}
                  className="underline font-semibold"
                >
                  Settings
                </button>
                {' '}to auto-identify items from photos.
              </span>
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
                value={form.value || ''}
                onChange={(e) => setForm({ ...form, value: e.target.value === '' ? 0 : +e.target.value })}
                placeholder="0.00"
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
                placeholder="Description, brand, color, etc."
              />
            </div>
          </div>
        </div>

        {/* Dimensions */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Ruler size={16} className="text-teal-600" />
              Dimensions (inches)
            </h2>
            <div className="flex items-center gap-2">
              {photos.length > 0 && isAIConfigured() && (
                <button
                  type="button"
                  disabled={aiMeasuring || aiLookingUp}
                  onClick={async () => {
                    setAiMeasuring(true)
                    setAiMeasureResult(null)
                    setAiMeasureError('')
                    try {
                      const base64 = await fileToBase64(photos[0])
                      const dims = await measureItemFromImage(base64, form.name || undefined)
                      setForm((prev) => ({
                        ...prev,
                        length_inches: dims.length_inches,
                        width_inches: dims.width_inches,
                        height_inches: dims.height_inches,
                      }))
                      setAiMeasureResult({ confidence: dims.confidence, notes: dims.notes })
                    } catch (err) {
                      setAiMeasureError(err instanceof Error ? err.message : 'Measurement failed')
                    } finally {
                      setAiMeasuring(false)
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600 text-white text-xs font-medium rounded-lg hover:bg-teal-700 disabled:opacity-50 transition-colors"
                >
                  {aiMeasuring ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      Measuring...
                    </>
                  ) : (
                    <>
                      <Camera size={12} />
                      AI Measure
                    </>
                  )}
                </button>
              )}
              {form.name && (
                <button
                  type="button"
                  disabled={aiMeasuring || aiLookingUp}
                  onClick={handleLookupDimensions}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {aiLookingUp ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      Searching...
                    </>
                  ) : (
                    <>
                      <Search size={12} />
                      Look Up
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowMagicPlanModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 text-white text-xs font-medium rounded-lg hover:bg-violet-700 transition-colors"
              >
                <Smartphone size={12} />
                MagicPlan
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-500">
            {photos.length > 0 && isAIConfigured()
              ? 'Tap "AI Measure" for photo, "Look Up" to search online, or "MagicPlan" to import from the app.'
              : form.name
                ? 'Enter manually, "Look Up" online, or tap "MagicPlan" to measure with your phone.'
                : 'Measure the furniture or tap "MagicPlan" to use your phone\'s AR measurement.'}
          </p>
          {aiMeasureResult && (
            <div className="flex items-start gap-2 text-xs bg-teal-500/10 text-teal-400 rounded-lg px-3 py-2">
              <Sparkles size={14} className="flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-medium">AI estimated ({aiMeasureResult.confidence} confidence)</span>
                {aiMeasureResult.notes && <span className="text-teal-300"> — {aiMeasureResult.notes}</span>}
              </div>
            </div>
          )}
          {aiMeasureError && (
            <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{aiMeasureError}</p>
          )}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Length</label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={form.length_inches || ''}
                onChange={(e) => setForm({ ...form, length_inches: e.target.value === '' ? 0 : +e.target.value })}
                placeholder="L"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Width</label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={form.width_inches || ''}
                onChange={(e) => setForm({ ...form, width_inches: e.target.value === '' ? 0 : +e.target.value })}
                placeholder="W"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Height</label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={form.height_inches || ''}
                onChange={(e) => setForm({ ...form, height_inches: e.target.value === '' ? 0 : +e.target.value })}
                placeholder="H"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
            </div>
          </div>
          {form.length_inches > 0 && form.width_inches > 0 && (
            <p className="text-xs text-teal-600">
              {form.length_inches}" x {form.width_inches}"
              {form.height_inches > 0 && ` x ${form.height_inches}"`}
              {' '}({(form.length_inches / 12).toFixed(1)}' x {(form.width_inches / 12).toFixed(1)}'
              {form.height_inches > 0 && ` x ${(form.height_inches / 12).toFixed(1)}'`})
            </p>
          )}
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
                value={form.purchase_price || ''}
                onChange={(e) => setForm({ ...form, purchase_price: e.target.value === '' ? 0 : +e.target.value })}
                placeholder="0.00"
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
                  ? 'bg-violet-600/20 border-violet-500/40 text-violet-300'
                  : 'border-slate-600 text-slate-400 hover:bg-slate-700'
              }`}
            >
              Storage Unit
            </button>
            <button
              type="button"
              onClick={() => handleLocationTypeChange('property')}
              className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium border transition-colors ${
                form.current_location_type === 'property'
                  ? 'bg-violet-600/20 border-violet-500/40 text-violet-300'
                  : 'border-slate-600 text-slate-400 hover:bg-slate-700'
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

      {/* MagicPlan Import Modal */}
      {showMagicPlanModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                <Smartphone size={20} className="text-violet-600" />
                MagicPlan Measurement
              </h3>
              <button
                type="button"
                onClick={() => { setShowMagicPlanModal(false); setMagicPlanError('') }}
                className="text-slate-400 hover:text-slate-600"
              >
                <X size={20} />
              </button>
            </div>

            <div className="space-y-3">
              <div className="bg-violet-50 rounded-lg p-3 space-y-2">
                <p className="text-sm font-medium text-violet-300">How to use:</p>
                <ol className="text-xs text-violet-400 space-y-1 list-decimal list-inside">
                  <li>Open MagicPlan on your phone</li>
                  <li>Use AR measurement to measure the item</li>
                  <li>Copy the dimensions from the app</li>
                  <li>Paste them below</li>
                </ol>
              </div>

              <a
                href={getMagicPlanLink()}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-2.5 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 transition-colors"
              >
                <Smartphone size={16} />
                Open MagicPlan App
              </a>

              <div className="border-t border-slate-200 pt-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Paste dimensions from MagicPlan
                </label>
                <input
                  type="text"
                  value={magicPlanText}
                  onChange={(e) => { setMagicPlanText(e.target.value); setMagicPlanError('') }}
                  placeholder="e.g. 84 x 36 x 30 or 213cm x 91cm x 76cm"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                />
                <p className="text-xs text-slate-400 mt-1">
                  Accepts inches, feet, cm, or meters (e.g. 213cm x 91cm x 76cm)
                </p>
                {magicPlanError && (
                  <p className="text-xs text-red-600 mt-1">{magicPlanError}</p>
                )}
              </div>

              <button
                type="button"
                onClick={handleMagicPlanImport}
                disabled={!magicPlanText.trim()}
                className="w-full py-2.5 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors"
              >
                Import Dimensions
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
