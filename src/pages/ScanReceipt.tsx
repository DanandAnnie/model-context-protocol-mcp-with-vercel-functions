import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Receipt, Camera, Upload, Loader2, Check, X, PlusCircle,
  Trash2, ChevronDown, ChevronUp, Image as ImageIcon,
} from 'lucide-react'
import { createWorker } from 'tesseract.js'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import { useStorageUnits } from '../hooks/useStorageUnits'
import type { ItemCategory, ItemInsert, PaymentMethod } from '../lib/database.types'

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

const CATEGORIES: { key: ItemCategory; label: string }[] = [
  { key: 'kitchen & dining', label: 'Kitchen & Dining' },
  { key: 'bedroom', label: 'Bedroom' },
  { key: 'living room', label: 'Living Room' },
  { key: 'office', label: 'Office' },
  { key: 'bathroom', label: 'Bathroom' },
  { key: 'outdoor', label: 'Outdoor' },
  { key: 'other', label: 'Other' },
]

interface ParsedItem {
  id: string
  name: string
  price: number
  category: ItemCategory
  included: boolean
}

// Guess category based on keywords in the item name
function guessCategory(name: string): ItemCategory {
  const n = name.toLowerCase()

  const kitchen = ['plate', 'bowl', 'cup', 'mug', 'glass', 'fork', 'knife', 'spoon', 'pan', 'pot', 'skillet', 'spatula', 'cutting board', 'blender', 'mixer', 'toaster', 'microwave', 'oven', 'dish', 'utensil', 'cookware', 'bakeware', 'table', 'dining', 'kitchen', 'silverware', 'platter', 'pitcher', 'kettle', 'coffee', 'tea', 'napkin', 'placemat']
  const bedroom = ['bed', 'mattress', 'pillow', 'sheet', 'blanket', 'comforter', 'duvet', 'headboard', 'nightstand', 'dresser', 'wardrobe', 'closet', 'lamp', 'bedroom', 'quilt', 'bedding']
  const living = ['sofa', 'couch', 'loveseat', 'recliner', 'armchair', 'ottoman', 'coffee table', 'end table', 'bookshelf', 'shelf', 'rug', 'carpet', 'curtain', 'drape', 'throw', 'cushion', 'vase', 'candle', 'frame', 'art', 'painting', 'mirror', 'living', 'decor', 'accent']
  const office = ['desk', 'chair', 'monitor', 'keyboard', 'mouse', 'printer', 'scanner', 'laptop', 'computer', 'office', 'shelf', 'organizer', 'filing', 'cabinet', 'stapler', 'pen']
  const bathroom = ['towel', 'bath', 'shower', 'soap', 'shampoo', 'toilet', 'sink', 'faucet', 'mirror', 'bathroom', 'mat', 'vanity', 'tissue']
  const outdoor = ['patio', 'garden', 'grill', 'outdoor', 'planter', 'umbrella', 'lawn', 'deck', 'fire pit', 'hose', 'fence', 'lantern']

  if (kitchen.some((k) => n.includes(k))) return 'kitchen & dining'
  if (bedroom.some((k) => n.includes(k))) return 'bedroom'
  if (bathroom.some((k) => n.includes(k))) return 'bathroom'
  if (office.some((k) => n.includes(k))) return 'office'
  if (outdoor.some((k) => n.includes(k))) return 'outdoor'
  if (living.some((k) => n.includes(k))) return 'living room'

  return 'other'
}

// Parse OCR text into line items with prices
function parseReceipt(text: string): ParsedItem[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const items: ParsedItem[] = []
  const seen = new Set<string>()

  for (const line of lines) {
    // Match lines with a price pattern: $12.99, 12.99, $1,234.56, etc.
    const priceMatch = line.match(/\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2}))\s*$/)
      || line.match(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*$/)
    if (!priceMatch) continue

    const priceStr = priceMatch[1].replace(/,/g, '')
    const price = parseFloat(priceStr)
    if (isNaN(price) || price <= 0) continue

    // Item name is the text before the price
    let name = line.slice(0, priceMatch.index).trim()
    // Clean up common OCR artifacts
    name = name.replace(/^[\-\.\*\#\s]+/, '').replace(/[\-\.\*\#\s]+$/, '').trim()

    if (!name || name.length < 2) continue

    // Skip totals, tax, subtotals, etc.
    const skip = /^(sub\s*total|total|tax|sales\s*tax|discount|tender|change|cash|credit|debit|visa|mastercard|amex|balance|payment|tip|gratuity|amount)/i
    if (skip.test(name)) continue

    const key = `${name.toLowerCase()}-${price}`
    if (seen.has(key)) continue
    seen.add(key)

    items.push({
      id: crypto.randomUUID(),
      name,
      price,
      category: guessCategory(name),
      included: true,
    })
  }

  return items
}

export default function ScanReceipt() {
  const navigate = useNavigate()
  const { addItem } = useItems()
  const { properties } = useProperties()
  const { units } = useStorageUnits()

  const [receiptImage, setReceiptImage] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState(0)
  const [rawText, setRawText] = useState('')
  const [parsedItems, setParsedItems] = useState<ParsedItem[]>([])
  const [showRawText, setShowRawText] = useState(false)
  const [step, setStep] = useState<'upload' | 'review' | 'saving' | 'done'>('upload')

  // Location assignment
  const [locationType, setLocationType] = useState<'storage' | 'property'>('property')
  const [selectedPropertyId, setSelectedPropertyId] = useState(properties[0]?.id || '')
  const [selectedStorageId, setSelectedStorageId] = useState(units[0]?.id || '')

  // Purchase info
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('other')
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().split('T')[0])

  const [saving, setSaving] = useState(false)
  const [savedCount, setSavedCount] = useState(0)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      setReceiptImage(reader.result as string)
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const handleScan = async () => {
    if (!receiptImage) return
    setScanning(true)
    setScanProgress(0)

    try {
      const worker = await createWorker('eng', undefined, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            setScanProgress(Math.round(m.progress * 100))
          }
        },
      })

      const { data } = await worker.recognize(receiptImage)
      await worker.terminate()

      setRawText(data.text)
      const items = parseReceipt(data.text)
      setParsedItems(items)
      setStep('review')
    } catch {
      alert('Failed to scan receipt. Please try again or enter items manually.')
    } finally {
      setScanning(false)
    }
  }

  const toggleItem = (id: string) => {
    setParsedItems((prev) =>
      prev.map((item) => item.id === id ? { ...item, included: !item.included } : item),
    )
  }

  const updateItem = (id: string, updates: Partial<ParsedItem>) => {
    setParsedItems((prev) =>
      prev.map((item) => item.id === id ? { ...item, ...updates } : item),
    )
  }

  const removeItem = (id: string) => {
    setParsedItems((prev) => prev.filter((item) => item.id !== id))
  }

  const addManualItem = () => {
    setParsedItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: '',
        price: 0,
        category: 'other',
        included: true,
      },
    ])
  }

  const handleSaveAll = async () => {
    const toSave = parsedItems.filter((item) => item.included && item.name.trim())
    if (toSave.length === 0) return

    setSaving(true)
    setStep('saving')
    let count = 0

    for (const parsed of toSave) {
      const newItem: ItemInsert = {
        name: parsed.name,
        category: parsed.category,
        subcategory: '',
        value: parsed.price,
        purchase_price: parsed.price,
        purchase_date: purchaseDate || null,
        payment_method: paymentMethod,
        receipt_url: receiptImage || '',
        useful_life_years: 7,
        condition: 'good',
        date_acquired: purchaseDate || new Date().toISOString().split('T')[0],
        notes: 'Added from receipt scan',
        photo_url: '',
        current_location_type: locationType,
        current_storage_id: locationType === 'storage' ? selectedStorageId : null,
        current_property_id: locationType === 'property' ? selectedPropertyId : null,
        status: locationType === 'property' ? 'staged' : 'available',
      }

      try {
        await addItem(newItem)
        count++
        setSavedCount(count)
      } catch {
        // continue with remaining items
      }
    }

    setStep('done')
    setSaving(false)
  }

  const includedCount = parsedItems.filter((i) => i.included && i.name.trim()).length
  const includedTotal = parsedItems
    .filter((i) => i.included && i.name.trim())
    .reduce((sum, i) => sum + i.price, 0)

  // Done screen
  if (step === 'done') {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-green-600">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
          <Check size={32} />
        </div>
        <p className="text-lg font-medium">{savedCount} Items Added!</p>
        <p className="text-sm text-slate-500 mt-1">From receipt scan</p>
        <button
          onClick={() => navigate('/inventory')}
          className="mt-4 px-6 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
        >
          View Inventory
        </button>
      </div>
    )
  }

  // Saving screen
  if (step === 'saving') {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <Loader2 size={32} className="animate-spin text-blue-600 mb-4" />
        <p className="text-lg font-medium text-slate-700">Saving Items...</p>
        <p className="text-sm text-slate-500 mt-1">
          {savedCount} of {includedCount} saved
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Receipt size={24} />
          Scan Receipt
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Upload a receipt to automatically extract items and prices
        </p>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageSelect}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleImageSelect}
      />

      {step === 'upload' && (
        <>
          {/* Receipt image upload */}
          {receiptImage ? (
            <div className="relative">
              <img
                src={receiptImage}
                alt="Receipt"
                className="w-full rounded-xl border border-slate-200 max-h-96 object-contain bg-slate-50"
              />
              <button
                onClick={() => { setReceiptImage(null); setRawText(''); setParsedItems([]) }}
                className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center">
              <ImageIcon size={40} className="mx-auto text-slate-300 mb-3" />
              <p className="text-sm text-slate-500 mb-4">Take a photo or upload an image of your receipt</p>
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

          {/* Location selection */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-slate-700">Assign Items To</h2>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setLocationType('property')}
                className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium border transition-colors ${
                  locationType === 'property'
                    ? 'bg-blue-50 border-blue-300 text-blue-700'
                    : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                Property
              </button>
              <button
                type="button"
                onClick={() => setLocationType('storage')}
                className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium border transition-colors ${
                  locationType === 'storage'
                    ? 'bg-blue-50 border-blue-300 text-blue-700'
                    : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                Storage Unit
              </button>
            </div>

            {locationType === 'property' && (
              <select
                value={selectedPropertyId}
                onChange={(e) => setSelectedPropertyId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">Select property...</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}

            {locationType === 'storage' && (
              <select
                value={selectedStorageId}
                onChange={(e) => setSelectedStorageId(e.target.value)}
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
          </div>

          {/* Payment & Date */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-slate-700">Purchase Details</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Payment Method</label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Purchase Date</label>
                <input
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Scan button */}
          <button
            onClick={handleScan}
            disabled={!receiptImage || scanning}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {scanning ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                Scanning... {scanProgress}%
              </>
            ) : (
              <>
                <Receipt size={18} />
                Scan Receipt
              </>
            )}
          </button>
        </>
      )}

      {step === 'review' && (
        <>
          {/* Receipt image (collapsed) */}
          {receiptImage && (
            <details className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <summary className="px-4 py-3 text-sm font-medium text-slate-600 cursor-pointer hover:bg-slate-50">
                View Receipt Image
              </summary>
              <img src={receiptImage} alt="Receipt" className="w-full max-h-64 object-contain bg-slate-50 p-2" />
            </details>
          )}

          {/* Raw OCR text toggle */}
          {rawText && (
            <button
              onClick={() => setShowRawText(!showRawText)}
              className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-700"
            >
              {showRawText ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {showRawText ? 'Hide' : 'Show'} raw text
            </button>
          )}
          {showRawText && (
            <pre className="bg-slate-50 rounded-lg border border-slate-200 p-3 text-xs text-slate-600 max-h-40 overflow-auto whitespace-pre-wrap">
              {rawText}
            </pre>
          )}

          {/* Extracted items */}
          <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">
                Extracted Items ({parsedItems.length})
              </h2>
              <button
                onClick={addManualItem}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
              >
                <PlusCircle size={14} />
                Add Item
              </button>
            </div>

            {parsedItems.length === 0 && (
              <div className="text-center py-6 text-slate-400">
                <Receipt size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">No items detected. Add items manually or try a clearer photo.</p>
              </div>
            )}

            <div className="space-y-3">
              {parsedItems.map((item) => (
                <div
                  key={item.id}
                  className={`rounded-lg border p-3 transition-all ${
                    item.included
                      ? 'border-slate-200 bg-white'
                      : 'border-slate-100 bg-slate-50 opacity-60'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => toggleItem(item.id)}
                      className={`mt-1 w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                        item.included
                          ? 'bg-blue-600 border-blue-600 text-white'
                          : 'border-slate-300 bg-white'
                      }`}
                    >
                      {item.included && <Check size={12} />}
                    </button>

                    <div className="flex-1 space-y-2">
                      <div className="flex gap-2">
                        <input
                          value={item.name}
                          onChange={(e) => updateItem(item.id, { name: e.target.value })}
                          placeholder="Item name"
                          className="flex-1 px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                        <div className="relative">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={item.price}
                            onChange={(e) => updateItem(item.id, { price: +e.target.value })}
                            className="w-24 pl-6 pr-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <select
                          value={item.category}
                          onChange={(e) => updateItem(item.id, { category: e.target.value as ItemCategory })}
                          className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs text-slate-600 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c.key} value={c.key}>{c.label}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => removeItem(item.id)}
                          className="p-1 text-slate-400 hover:text-red-500"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Summary and save */}
          <div className="bg-blue-50 rounded-xl border border-blue-200 p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-blue-900">
                {includedCount} item{includedCount !== 1 ? 's' : ''} selected
              </p>
              <p className="text-xs text-blue-600">
                Total: ${includedTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </p>
            </div>
            <p className="text-xs text-blue-600">
              {locationType === 'property'
                ? properties.find((p) => p.id === selectedPropertyId)?.name || 'No property'
                : units.find((u) => u.id === selectedStorageId)?.name || 'No storage'}
            </p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => { setStep('upload'); setParsedItems([]); setRawText('') }}
              className="flex-1 py-3 border border-slate-300 text-slate-700 rounded-lg font-medium hover:bg-slate-50"
            >
              Re-scan
            </button>
            <button
              onClick={handleSaveAll}
              disabled={saving || includedCount === 0}
              className="flex-1 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <Check size={18} />
              Add {includedCount} Item{includedCount !== 1 ? 's' : ''}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
