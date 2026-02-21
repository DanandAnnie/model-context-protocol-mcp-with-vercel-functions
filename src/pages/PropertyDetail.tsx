import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Home, Package, Save, Trash2, Check, AlertTriangle,
  Camera, Upload, X, Image as ImageIcon, MapPin, DollarSign,
  PlusCircle, CreditCard, ChevronDown, ChevronUp,
} from 'lucide-react'
import { useProperties } from '../hooks/useProperties'
import { useItems } from '../hooks/useItems'
import { usePayments } from '../hooks/usePayments'
import ItemCard from '../components/ItemCard'
import type { PropertyInsert, PropertyType, PaymentMethod, StagingPaymentInsert } from '../lib/database.types'

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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function PropertyDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { properties, loading: propsLoading, updateProperty, deleteProperty } = useProperties()
  const { items, loading: itemsLoading } = useItems()
  const { payments, addPayment, deletePayment } = usePayments(id)

  const property = properties.find((p) => p.id === id)
  const propertyItems = items.filter((i) => i.current_property_id === id)
  const totalValue = propertyItems.reduce((sum, i) => sum + i.value, 0)
  const loading = propsLoading || itemsLoading

  const [form, setForm] = useState<PropertyInsert | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showAddPayment, setShowAddPayment] = useState(false)
  const [showPaymentHistory, setShowPaymentHistory] = useState(false)
  const [paymentForm, setPaymentForm] = useState({
    amount: 0,
    payment_date: new Date().toISOString().split('T')[0],
    payment_method: 'square' as PaymentMethod,
    month_covered: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
    square_transaction_id: '',
    notes: '',
  })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  // Load property into form
  useEffect(() => {
    if (!property) return
    setForm({
      name: property.name,
      address: property.address,
      city: property.city,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      sqft: property.sqft,
      property_type: property.property_type,
      monthly_fee: property.monthly_fee ?? 0,
      staging_start_date: property.staging_start_date ?? null,
      notes: property.notes,
      photo_url: property.photo_url || '',
    })
    if (property.photo_url) {
      setPhotoPreview(property.photo_url)
    }
    // Pre-fill payment amount
    if (property.monthly_fee) {
      setPaymentForm((prev) => ({ ...prev, amount: property.monthly_fee }))
    }
  }, [property])

  // Payment summary
  const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0)
  const paidMonths = new Set(payments.map((p) => p.month_covered))

  // Generate list of months from staging start to now
  const monthlyBreakdown = useMemo(() => {
    if (!form?.staging_start_date) return []
    const start = new Date(form.staging_start_date)
    const now = new Date()
    const months: { key: string; label: string; paid: boolean; amount: number; method?: string }[] = []

    const cursor = new Date(start.getFullYear(), start.getMonth(), 1)
    while (cursor <= now) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`
      const payment = payments.find((p) => p.month_covered === key)
      months.push({
        key,
        label: `${MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`,
        paid: !!payment,
        amount: payment?.amount || 0,
        method: payment ? PAYMENT_METHODS.find((m) => m.key === payment.payment_method)?.label : undefined,
      })
      cursor.setMonth(cursor.getMonth() + 1)
    }

    return months.reverse() // newest first
  }, [form?.staging_start_date, payments])

  const totalOwed = monthlyBreakdown.length * (form?.monthly_fee || 0)
  const balance = totalOwed - totalPaid

  const handleAddPayment = async () => {
    if (!id || !paymentForm.amount) return
    const payment: StagingPaymentInsert = {
      property_id: id,
      amount: paymentForm.amount,
      payment_date: paymentForm.payment_date,
      payment_method: paymentForm.payment_method,
      month_covered: paymentForm.month_covered,
      square_transaction_id: paymentForm.square_transaction_id,
      notes: paymentForm.notes,
    }
    await addPayment(payment)
    setShowAddPayment(false)
    setPaymentForm((prev) => ({ ...prev, square_transaction_id: '', notes: '' }))
  }

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
      await updateProperty(id, form)
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
      await deleteProperty(id)
      navigate('/properties')
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

  if (!property || !form) {
    return (
      <div className="text-center py-12">
        <p className="text-slate-500">Property not found</p>
        <Link to="/properties" className="text-blue-600 text-sm mt-2 inline-block">Back to properties</Link>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <Link
          to="/properties"
          className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft size={16} />
          Back to properties
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

      {/* Property Photo */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-2">Property Photo</label>
        {photoPreview ? (
          <div className="relative rounded-xl overflow-hidden">
            <img src={photoPreview} alt="Property" className="w-full aspect-video object-cover" />
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
            <p className="text-sm text-slate-500 mb-4">Add a photo of this property</p>
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
          <Home size={16} className="text-blue-700" />
          Property Details
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
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">City</label>
            <input
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
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
            <label className="block text-sm font-medium text-slate-700 mb-1">Monthly Staging Fee ($)</label>
            <input
              type="number"
              min={0}
              step={50}
              value={form.monthly_fee}
              onChange={(e) => setForm({ ...form, monthly_fee: +e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Staging Start Date</label>
            <input
              type="date"
              value={form.staging_start_date || ''}
              onChange={(e) => setForm({ ...form, staging_start_date: e.target.value || null })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div className="md:col-span-2">
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

      {/* Google Map */}
      {(form.address || form.city) && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between p-4 pb-0">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <MapPin size={16} className="text-red-500" />
              Location
            </h2>
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([form.address, form.city].filter(Boolean).join(', '))}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:text-blue-700"
            >
              Open in Google Maps
            </a>
          </div>
          <div className="p-4">
            <iframe
              title="Property location"
              width="100%"
              height="250"
              style={{ border: 0, borderRadius: '0.75rem' }}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              src={`https://maps.google.com/maps?q=${encodeURIComponent([form.address, form.city].filter(Boolean).join(', '))}&t=&z=15&ie=UTF8&iwloc=&output=embed`}
            />
          </div>
        </div>
      )}

      {/* Billing & Payments */}
      {form.monthly_fee > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <DollarSign size={16} className="text-green-600" />
                Billing & Payments
              </h2>
              <button
                onClick={() => setShowAddPayment(!showAddPayment)}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
              >
                <PlusCircle size={14} />
                Record Payment
              </button>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-xs text-slate-500">Monthly Fee</p>
                <p className="text-lg font-bold text-slate-900">${form.monthly_fee.toLocaleString()}</p>
              </div>
              <div className="bg-green-50 rounded-lg p-3">
                <p className="text-xs text-green-600">Total Paid</p>
                <p className="text-lg font-bold text-green-700">${totalPaid.toLocaleString()}</p>
              </div>
              <div className={`rounded-lg p-3 ${balance > 0 ? 'bg-red-50' : 'bg-green-50'}`}>
                <p className={`text-xs ${balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {balance > 0 ? 'Balance Due' : 'Overpaid'}
                </p>
                <p className={`text-lg font-bold ${balance > 0 ? 'text-red-700' : 'text-green-700'}`}>
                  ${Math.abs(balance).toLocaleString()}
                </p>
              </div>
            </div>

            {/* Add payment form */}
            {showAddPayment && (
              <div className="border border-blue-200 bg-blue-50/50 rounded-lg p-4 space-y-3">
                <h3 className="text-sm font-medium text-slate-700">Record Payment</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Amount ($)</label>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={paymentForm.amount}
                      onChange={(e) => setPaymentForm({ ...paymentForm, amount: +e.target.value })}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Payment Date</label>
                    <input
                      type="date"
                      value={paymentForm.payment_date}
                      onChange={(e) => setPaymentForm({ ...paymentForm, payment_date: e.target.value })}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Payment Method</label>
                    <select
                      value={paymentForm.payment_method}
                      onChange={(e) => setPaymentForm({ ...paymentForm, payment_method: e.target.value as PaymentMethod })}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500"
                    >
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m.key} value={m.key}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Month Covered</label>
                    <input
                      type="month"
                      value={paymentForm.month_covered}
                      onChange={(e) => setPaymentForm({ ...paymentForm, month_covered: e.target.value })}
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  {paymentForm.payment_method === 'square' && (
                    <div className="col-span-2">
                      <label className="block text-xs text-slate-500 mb-1">Square Transaction ID</label>
                      <input
                        value={paymentForm.square_transaction_id}
                        onChange={(e) => setPaymentForm({ ...paymentForm, square_transaction_id: e.target.value })}
                        placeholder="e.g. sq_txn_abc123"
                        className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  )}
                  <div className="col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">Notes</label>
                    <input
                      value={paymentForm.notes}
                      onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                      placeholder="Optional notes"
                      className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleAddPayment}
                    className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
                  >
                    Save Payment
                  </button>
                  <button
                    onClick={() => setShowAddPayment(false)}
                    className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Monthly breakdown */}
            {monthlyBreakdown.length > 0 && (
              <div>
                <button
                  onClick={() => setShowPaymentHistory(!showPaymentHistory)}
                  className="flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-800 mb-2"
                >
                  {showPaymentHistory ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  Monthly Breakdown ({paidMonths.size}/{monthlyBreakdown.length} paid)
                </button>

                {showPaymentHistory && (
                  <div className="space-y-1">
                    {monthlyBreakdown.map((month) => (
                      <div
                        key={month.key}
                        className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                          month.paid ? 'bg-green-50' : 'bg-red-50'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {month.paid ? (
                            <Check size={14} className="text-green-600" />
                          ) : (
                            <X size={14} className="text-red-400" />
                          )}
                          <span className="font-medium">{month.label}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {month.paid ? (
                            <>
                              <span className="text-green-700 font-medium">${month.amount.toLocaleString()}</span>
                              <span className="flex items-center gap-1 text-xs text-slate-500">
                                <CreditCard size={10} />
                                {month.method}
                              </span>
                            </>
                          ) : (
                            <span className="text-red-500 text-xs font-medium">Unpaid</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Recent payments */}
            {payments.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-slate-500 mb-2">Recent Payments</h3>
                <div className="space-y-1">
                  {payments.slice(0, 5).map((p) => (
                    <div key={p.id} className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg text-sm group">
                      <div>
                        <span className="font-medium text-slate-700">${p.amount.toLocaleString()}</span>
                        <span className="text-slate-400 mx-2">&middot;</span>
                        <span className="text-slate-500 text-xs">{new Date(p.payment_date).toLocaleDateString()}</span>
                        {p.square_transaction_id && (
                          <span className="text-xs text-blue-500 ml-2">SQ: {p.square_transaction_id}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500">
                          {PAYMENT_METHODS.find((m) => m.key === p.payment_method)?.label}
                        </span>
                        <button
                          onClick={() => { if (confirm('Delete this payment?')) deletePayment(p.id) }}
                          className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Staged items */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Package size={18} />
            Staged Items ({propertyItems.length})
          </h2>
          <span className="text-sm font-medium text-slate-600">
            Total: ${totalValue.toLocaleString()}
          </span>
        </div>

        {propertyItems.length > 0 ? (
          <div className="space-y-2">
            {propertyItems.map((item) => (
              <ItemCard key={item.id} item={item} locationName={property.name} onClick={() => navigate(`/items/${item.id}`)} />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
            <Package size={36} className="mx-auto text-slate-300 mb-2" />
            <p className="text-slate-400 text-sm">No items staged at this property</p>
            <Link
              to="/staging-planner"
              className="text-blue-600 text-sm mt-2 inline-block hover:text-blue-700"
            >
              Go to Staging Planner
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
                <h3 className="font-semibold text-slate-900">Delete Property</h3>
                <p className="text-sm text-slate-500 mt-0.5">This action cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm text-slate-600">
              Are you sure you want to delete <span className="font-medium">{property.name}</span>?
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
