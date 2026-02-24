import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Package, Save, Trash2, Check, AlertTriangle, ExternalLink, Copy, MapPin, DollarSign, Ruler, Camera, Loader2, Sparkles, Search, Smartphone, X } from 'lucide-react'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import { useStorageUnits } from '../hooks/useStorageUnits'
import PhotoGallery from '../components/PhotoGallery'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { isAIConfigured, measureItemFromImage, lookupDimensions, getMagicPlanLink, parseDimensionText } from '../lib/ai'
import { fileToBase64, getAllPhotos, addAdditionalPhoto, removeAdditionalPhoto, setAsPrimaryPhoto } from '../lib/photos'
import type { ItemInsert, ItemCategory, ItemCondition, ItemStatus, LocationType, PaymentMethod } from '../lib/database.types'

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
  const [allPhotos, setAllPhotos] = useState<string[]>([])
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [copiedToClipboard, setCopiedToClipboard] = useState(false)
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
    setForm((prev) => prev ? ({
      ...prev,
      length_inches: dims.length_inches,
      width_inches: dims.width_inches,
      height_inches: dims.height_inches,
    }) : prev)
    setAiMeasureResult({ confidence: dims.confidence, notes: dims.notes })
    setShowMagicPlanModal(false)
    setMagicPlanText('')
  }

  // Photo gallery helpers
  const refreshPhotos = useCallback(() => {
    if (!id || !form) return
    setAllPhotos(getAllPhotos('item', id, form.photo_url))
  }, [id, form?.photo_url])

  useEffect(() => { refreshPhotos() }, [refreshPhotos])

  // Supabase gallery sync (additional cloud photos)
  const loadGallery = useCallback(async () => {
    if (!id || !isSupabaseConfigured()) return
    // Supabase gallery images are also synced to local allPhotos via addAdditionalPhoto
  }, [id])

  useEffect(() => { loadGallery() }, [loadGallery])

  const handleAddItemPhoto = async (file: File) => {
    if (!id || !form) return
    setUploadingPhoto(true)
    try {
      const base64 = await fileToBase64(file)
      if (!form.photo_url) {
        setForm({ ...form, photo_url: base64 })
      } else {
        addAdditionalPhoto('item', id, base64)
      }
      // Also upload to Supabase if configured
      if (isSupabaseConfigured()) {
        const ext = file.name.split('.').pop()
        const path = `${id}/${crypto.randomUUID()}.${ext}`
        const { error: uploadErr } = await supabase.storage
          .from('item-images')
          .upload(path, file, { upsert: true })
        if (!uploadErr) {
          const { data: urlData } = supabase.storage
            .from('item-images')
            .getPublicUrl(path)
          await supabase.from('item_images').insert({
            item_id: id,
            image_url: urlData.publicUrl,
            is_primary: !form.photo_url,
          })
          await loadGallery()
        }
      }
      setAllPhotos(getAllPhotos('item', id, form.photo_url || base64))
    } finally {
      setUploadingPhoto(false)
    }
  }

  const handleDeleteItemPhoto = (index: number) => {
    if (!id || !form) return
    if (index === 0) {
      const remaining = getAllPhotos('item', id, undefined)
      if (remaining.length > 0) {
        const newPrimary = remaining[0]
        removeAdditionalPhoto('item', id, 0)
        setForm({ ...form, photo_url: newPrimary })
      } else {
        setForm({ ...form, photo_url: '' })
      }
    } else {
      removeAdditionalPhoto('item', id, index - 1)
    }
    setTimeout(refreshPhotos, 0)
  }

  const handleSetItemPrimary = (index: number) => {
    if (!id || !form || index === 0) return
    const result = setAsPrimaryPhoto('item', id, index)
    if (result) {
      if (form.photo_url) {
        addAdditionalPhoto('item', id, form.photo_url)
      }
      setForm({ ...form, photo_url: result.newPrimary })
      setTimeout(refreshPhotos, 0)
    }
  }

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
      length_inches: item.length_inches ?? 0,
      width_inches: item.width_inches ?? 0,
      height_inches: item.height_inches ?? 0,
    })

    // Load all photos (primary + additional from localStorage)
    setAllPhotos(getAllPhotos('item', item.id, item.photo_url))
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
      await updateItem(id, form)
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

  // Marketplace listing helpers
  const locationAddress = (() => {
    if (item.current_location_type === 'property') {
      const prop = properties.find((p) => p.id === item.current_property_id)
      return prop ? [prop.address, prop.city].filter(Boolean).join(', ') : ''
    }
    const unit = units.find((u) => u.id === item.current_storage_id)
    return unit?.address || ''
  })()

  const conditionMultiplier = { excellent: 0.8, good: 0.6, fair: 0.4, poor: 0.2 }
  const recommendedPrice = Math.round(item.value * (conditionMultiplier[item.condition] || 0.6))

  const hasDimensions = item.length_inches > 0 && item.width_inches > 0
  const dimensionStr = hasDimensions
    ? `Dimensions: ${item.length_inches}" x ${item.width_inches}"${item.height_inches > 0 ? ` x ${item.height_inches}"` : ''} (${(item.length_inches / 12).toFixed(1)}' x ${(item.width_inches / 12).toFixed(1)}'${item.height_inches > 0 ? ` x ${(item.height_inches / 12).toFixed(1)}'` : ''})`
    : ''

  const marketplaceListing = [
    `${item.name} - ${item.category}`,
    '',
    `Condition: ${item.condition}`,
    item.subcategory ? `Type: ${item.subcategory}` : '',
    dimensionStr,
    item.notes || '',
    '',
    `Retail Value: $${item.value.toLocaleString()}`,
    `Asking Price: $${recommendedPrice.toLocaleString()}`,
    '',
    locationAddress ? `Location: ${locationAddress}` : '',
  ].filter(Boolean).join('\n')

  const handleCopyListing = async () => {
    await navigator.clipboard.writeText(marketplaceListing)
    setCopiedToClipboard(true)
    setTimeout(() => setCopiedToClipboard(false), 2000)
  }

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

      {/* Photo Gallery */}
      <PhotoGallery
        photos={allPhotos}
        onAddPhoto={handleAddItemPhoto}
        onDeletePhoto={handleDeleteItemPhoto}
        onSetPrimary={handleSetItemPrimary}
        uploading={uploadingPhoto}
        label="Item Photos"
      />

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

      {/* Dimensions */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Ruler size={16} className="text-teal-600" />
            Dimensions (inches)
          </h2>
          <div className="flex items-center gap-2">
            {allPhotos.length > 0 && isAIConfigured() && (
              <button
                type="button"
                disabled={aiMeasuring || aiLookingUp}
                onClick={async () => {
                  setAiMeasuring(true)
                  setAiMeasureResult(null)
                  setAiMeasureError('')
                  try {
                    const base64 = allPhotos[0]
                    if (!base64) throw new Error('No photo available')
                    const dims = await measureItemFromImage(base64, item.name)
                    setForm((prev) => prev ? ({
                      ...prev,
                      length_inches: dims.length_inches,
                      width_inches: dims.width_inches,
                      height_inches: dims.height_inches,
                    }) : prev)
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
            <button
              type="button"
              disabled={aiMeasuring || aiLookingUp}
              onClick={async () => {
                setAiLookingUp(true)
                setAiMeasureResult(null)
                setAiMeasureError('')
                try {
                  const dims = await lookupDimensions(item.name, item.category, item.subcategory)
                  setForm((prev) => prev ? ({
                    ...prev,
                    length_inches: dims.length_inches,
                    width_inches: dims.width_inches,
                    height_inches: dims.height_inches,
                  }) : prev)
                  setAiMeasureResult({ confidence: dims.confidence, notes: dims.notes })
                } catch (err) {
                  setAiMeasureError(err instanceof Error ? err.message : 'Lookup failed')
                } finally {
                  setAiLookingUp(false)
                }
              }}
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
        {aiMeasureResult && (
          <div className="flex items-start gap-2 text-xs bg-teal-50 text-teal-700 rounded-lg px-3 py-2">
            <Sparkles size={14} className="flex-shrink-0 mt-0.5" />
            <div>
              <span className="font-medium">AI estimated ({aiMeasureResult.confidence} confidence)</span>
              {aiMeasureResult.notes && <span className="text-teal-600"> — {aiMeasureResult.notes}</span>}
            </div>
          </div>
        )}
        {aiMeasureError && (
          <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{aiMeasureError}</p>
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

      {/* Check Room Fit — link to property detail where room measurements live */}
      {hasDimensions && (
        <div className="bg-teal-50 border border-teal-200 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Ruler size={18} className="text-teal-700" />
            <div>
              <p className="text-sm font-medium text-teal-900">Check Room Fit</p>
              <p className="text-xs text-teal-600">
                {form.length_inches}" x {form.width_inches}"
                {form.height_inches > 0 && ` x ${form.height_inches}"`} — see if this fits in a room
              </p>
            </div>
          </div>
          {item.current_location_type === 'property' && item.current_property_id ? (
            <Link
              to={`/properties/${item.current_property_id}`}
              className="px-3 py-1.5 bg-teal-600 text-white text-sm font-medium rounded-lg hover:bg-teal-700 transition-colors whitespace-nowrap"
            >
              View Rooms
            </Link>
          ) : (
            <Link
              to="/properties"
              className="px-3 py-1.5 bg-teal-600 text-white text-sm font-medium rounded-lg hover:bg-teal-700 transition-colors whitespace-nowrap"
            >
              Go to Properties
            </Link>
          )}
        </div>
      )}

      {/* Sell on Marketplace */}
      <div className="bg-white rounded-xl border border-purple-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <DollarSign size={16} className="text-purple-600" />
          Sell on Marketplace
        </h2>

        {/* Price comparison */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-slate-50 rounded-lg p-3">
            <p className="text-xs text-slate-500">Your Cost</p>
            <p className="text-lg font-bold text-slate-900">${(item.purchase_price || 0).toLocaleString()}</p>
          </div>
          <div className="bg-blue-50 rounded-lg p-3">
            <p className="text-xs text-blue-600">Retail Value</p>
            <p className="text-lg font-bold text-blue-700">${item.value.toLocaleString()}</p>
          </div>
          <div className="bg-green-50 rounded-lg p-3">
            <p className="text-xs text-green-600">Recommended Price</p>
            <p className="text-lg font-bold text-green-700">${recommendedPrice.toLocaleString()}</p>
          </div>
        </div>

        {/* Location */}
        {locationAddress && (
          <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-lg text-sm">
            <MapPin size={14} className="text-slate-400" />
            <span className="text-slate-600">{locationAddress}</span>
          </div>
        )}

        {/* Listing preview */}
        <div className="bg-slate-50 rounded-lg p-3">
          <p className="text-xs text-slate-500 mb-1">Listing Preview</p>
          <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans">{marketplaceListing}</pre>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            onClick={handleCopyListing}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors"
          >
            {copiedToClipboard ? (
              <>
                <Check size={16} />
                Copied!
              </>
            ) : (
              <>
                <Copy size={16} />
                Copy Listing
              </>
            )}
          </button>
          <a
            href="https://www.facebook.com/marketplace/create/item"
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            <ExternalLink size={16} />
            Open Facebook Marketplace
          </a>
        </div>

        <p className="text-xs text-slate-400">
          Copy the listing details above, then paste them into your Facebook Marketplace listing.
        </p>
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
                <p className="text-sm font-medium text-violet-800">How to use:</p>
                <ol className="text-xs text-violet-700 space-y-1 list-decimal list-inside">
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
