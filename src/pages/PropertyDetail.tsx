import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Home, Package, Save, Trash2, Check, AlertTriangle,
  MapPin, DollarSign, Camera, X,
  PlusCircle, CreditCard, ChevronDown, ChevronUp,
  BarChart3, TrendingUp, Edit2, Ruler, CheckCircle2, XCircle,
  Loader2, Sparkles,
} from 'lucide-react'
import { isAIConfigured, measureRoomFromImage } from '../lib/ai'
import { useProperties } from '../hooks/useProperties'
import { useItems } from '../hooks/useItems'
import { usePayments } from '../hooks/usePayments'
import { usePropertyExpenses } from '../hooks/usePropertyExpenses'
import ItemCard from '../components/ItemCard'
import PhotoGallery from '../components/PhotoGallery'
import { fileToBase64, getAllPhotos, addAdditionalPhoto, removeAdditionalPhoto, setAsPrimaryPhoto } from '../lib/photos'
import type { PropertyInsert, PropertyType, PaymentMethod, StagingPaymentInsert, PropertyExpenseInsert, ExpenseCategory } from '../lib/database.types'

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

const EXPENSE_CATEGORIES: { key: ExpenseCategory; label: string }[] = [
  { key: 'design_fee', label: 'Design Fee' },
  { key: 'movers', label: 'Movers' },
  { key: 'travel', label: 'Travel' },
  { key: 'supplies', label: 'Supplies' },
  { key: 'other', label: 'Other' },
]

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Room measurement types
interface Room {
  id: string
  name: string
  length_ft: number
  width_ft: number
}

function getRooms(propertyId: string): Room[] {
  try {
    const stored = localStorage.getItem(`property_rooms_${propertyId}`)
    if (stored) return JSON.parse(stored)
  } catch { /* empty */ }
  return []
}

function saveRooms(propertyId: string, rooms: Room[]) {
  localStorage.setItem(`property_rooms_${propertyId}`, JSON.stringify(rooms))
}

export default function PropertyDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { properties, loading: propsLoading, updateProperty, deleteProperty } = useProperties()
  const { items, loading: itemsLoading } = useItems()
  const { payments, addPayment, deletePayment } = usePayments(id)
  const { expenses, addExpense, updateExpense, deleteExpense } = usePropertyExpenses(id)

  const property = properties.find((p) => p.id === id)
  const propertyItems = items.filter((i) => i.current_property_id === id)
  const totalValue = propertyItems.reduce((sum, i) => sum + i.value, 0)
  const loading = propsLoading || itemsLoading

  const [form, setForm] = useState<PropertyInsert | null>(null)
  const [allPhotos, setAllPhotos] = useState<string[]>([])
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showAddPayment, setShowAddPayment] = useState(false)
  const [showPaymentHistory, setShowPaymentHistory] = useState(false)
  const [showAddExpense, setShowAddExpense] = useState(false)
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null)
  const [expenseForm, setExpenseForm] = useState({
    category: 'design_fee' as ExpenseCategory,
    description: '',
    amount: 0,
    expense_date: new Date().toISOString().split('T')[0],
    notes: '',
  })
  const [paymentForm, setPaymentForm] = useState({
    amount: 0,
    payment_date: new Date().toISOString().split('T')[0],
    payment_method: 'square' as PaymentMethod,
    month_covered: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
    square_transaction_id: '',
    notes: '',
  })
  // Room measurements
  const [rooms, setRooms] = useState<Room[]>([])
  const [showAddRoom, setShowAddRoom] = useState(false)
  const [roomForm, setRoomForm] = useState({ name: '', length_ft: 0, width_ft: 0 })
  const [showFitChecker, setShowFitChecker] = useState(false)
  const [aiMeasuringRoom, setAiMeasuringRoom] = useState(false)
  const [aiRoomResult, setAiRoomResult] = useState<{ confidence: string; notes: string } | null>(null)
  const [aiRoomError, setAiRoomError] = useState('')
  const roomPhotoInputRef = useRef<HTMLInputElement>(null)

  const handleAIRoomMeasure = async (file: File) => {
    setAiMeasuringRoom(true)
    setAiRoomResult(null)
    setAiRoomError('')
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const result = await measureRoomFromImage(base64)
      setRoomForm({ name: result.name, length_ft: result.length_ft, width_ft: result.width_ft })
      setAiRoomResult({ confidence: result.confidence, notes: result.notes })
      setShowAddRoom(true)
    } catch (err) {
      setAiRoomError(err instanceof Error ? err.message : 'Room measurement failed')
    } finally {
      setAiMeasuringRoom(false)
    }
  }

  const loadRooms = useCallback(() => {
    if (id) setRooms(getRooms(id))
  }, [id])

  useEffect(() => { loadRooms() }, [loadRooms])

  const handleAddRoom = () => {
    if (!id || !roomForm.name || !roomForm.length_ft || !roomForm.width_ft) return
    const newRoom: Room = { id: crypto.randomUUID(), ...roomForm }
    const updated = [...rooms, newRoom]
    saveRooms(id, updated)
    setRooms(updated)
    setRoomForm({ name: '', length_ft: 0, width_ft: 0 })
    setShowAddRoom(false)
  }

  const handleDeleteRoom = (roomId: string) => {
    if (!id) return
    const updated = rooms.filter((r) => r.id !== roomId)
    saveRooms(id, updated)
    setRooms(updated)
  }

  // Items with dimensions for fit checking
  const measuredItems = propertyItems.length > 0
    ? items.filter((i) => i.length_inches > 0 && i.width_inches > 0)
    : items.filter((i) => i.length_inches > 0 && i.width_inches > 0 && i.status === 'available')

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
    // Load all photos (primary + additional)
    setAllPhotos(getAllPhotos('property', property.id, property.photo_url))
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

  // Cost Analysis calculations
  const furnitureCost = propertyItems.reduce((sum, i) => sum + (i.purchase_price || 0), 0)
  const furnitureRetailValue = propertyItems.reduce((sum, i) => sum + (i.value || 0), 0)
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0)
  const totalCosts = furnitureCost + totalExpenses
  const totalRevenue = totalPaid
  const profitLoss = totalRevenue - totalCosts
  const breakEvenRemaining = Math.max(0, totalCosts - totalRevenue)
  const monthlyFee = form?.monthly_fee || 0
  const monthsToBreakEven = monthlyFee > 0 ? Math.ceil(breakEvenRemaining / monthlyFee) : null
  const breakEvenReached = totalRevenue >= totalCosts

  const expensesByCategory = useMemo(() => {
    const grouped: Record<string, number> = {}
    for (const exp of expenses) {
      grouped[exp.category] = (grouped[exp.category] || 0) + exp.amount
    }
    return grouped
  }, [expenses])

  const handleAddExpense = async () => {
    if (!id || !expenseForm.amount) return
    const expense: PropertyExpenseInsert = {
      property_id: id,
      category: expenseForm.category,
      description: expenseForm.description,
      amount: expenseForm.amount,
      expense_date: expenseForm.expense_date || null,
      notes: expenseForm.notes,
    }
    await addExpense(expense)
    setShowAddExpense(false)
    setExpenseForm({ category: 'design_fee', description: '', amount: 0, expense_date: new Date().toISOString().split('T')[0], notes: '' })
  }

  const handleUpdateExpense = async () => {
    if (!editingExpenseId) return
    await updateExpense(editingExpenseId, {
      property_id: id!,
      category: expenseForm.category,
      description: expenseForm.description,
      amount: expenseForm.amount,
      expense_date: expenseForm.expense_date || null,
      notes: expenseForm.notes,
    })
    setEditingExpenseId(null)
    setShowAddExpense(false)
    setExpenseForm({ category: 'design_fee', description: '', amount: 0, expense_date: new Date().toISOString().split('T')[0], notes: '' })
  }

  const startEditExpense = (expense: typeof expenses[0]) => {
    setEditingExpenseId(expense.id)
    setExpenseForm({
      category: expense.category as ExpenseCategory,
      description: expense.description,
      amount: expense.amount,
      expense_date: expense.expense_date || new Date().toISOString().split('T')[0],
      notes: expense.notes,
    })
    setShowAddExpense(true)
  }

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

  const refreshPhotos = useCallback(() => {
    if (!id || !form) return
    setAllPhotos(getAllPhotos('property', id, form.photo_url))
  }, [id, form?.photo_url])

  useEffect(() => { refreshPhotos() }, [refreshPhotos])

  const handleAddPropertyPhoto = async (file: File) => {
    if (!id || !form) return
    setUploadingPhoto(true)
    try {
      const base64 = await fileToBase64(file)
      if (!form.photo_url) {
        // No primary yet — set as primary
        setForm({ ...form, photo_url: base64 })
      } else {
        addAdditionalPhoto('property', id, base64)
      }
      setAllPhotos(getAllPhotos('property', id, form.photo_url || base64))
    } finally {
      setUploadingPhoto(false)
    }
  }

  const handleDeletePropertyPhoto = (index: number) => {
    if (!id || !form) return
    if (index === 0) {
      // Deleting primary — promote first additional to primary
      const remainingAdditional = getAllPhotos('property', id, undefined)
      if (remainingAdditional.length > 0) {
        // Promote first additional to primary
        const newPrimary = remainingAdditional[0]
        removeAdditionalPhoto('property', id, 0)
        setForm({ ...form, photo_url: newPrimary })
      } else {
        setForm({ ...form, photo_url: '' })
      }
    } else {
      removeAdditionalPhoto('property', id, index - 1)
    }
    setTimeout(refreshPhotos, 0)
  }

  const handleSetPropertyPrimary = (index: number) => {
    if (!id || !form || index === 0) return
    const result = setAsPrimaryPhoto('property', id, index)
    if (result) {
      // Old primary becomes additional
      if (form.photo_url) {
        addAdditionalPhoto('property', id, form.photo_url)
      }
      setForm({ ...form, photo_url: result.newPrimary })
      setTimeout(refreshPhotos, 0)
    }
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

      {/* Property Photos */}
      <PhotoGallery
        photos={allPhotos}
        onAddPhoto={handleAddPropertyPhoto}
        onDeletePhoto={handleDeletePropertyPhoto}
        onSetPrimary={handleSetPropertyPrimary}
        uploading={uploadingPhoto}
        label="Property Photos"
      />

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

      {/* Cost Analysis & Break-Even */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <BarChart3 size={16} className="text-purple-600" />
              Cost Analysis & Break-Even
            </h2>
            <button
              onClick={() => { setShowAddExpense(!showAddExpense); setEditingExpenseId(null) }}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
            >
              <PlusCircle size={14} />
              Add Expense
            </button>
          </div>

          {/* Break-even status banner */}
          <div className={`rounded-lg p-4 ${breakEvenReached ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}`}>
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp size={16} className={breakEvenReached ? 'text-green-600' : 'text-amber-600'} />
              <span className={`text-sm font-semibold ${breakEvenReached ? 'text-green-700' : 'text-amber-700'}`}>
                {breakEvenReached ? 'Break-Even Reached!' : 'Not Yet at Break-Even'}
              </span>
            </div>
            {breakEvenReached ? (
              <p className="text-sm text-green-600">
                Profit: <span className="font-bold">${profitLoss.toLocaleString()}</span>
              </p>
            ) : (
              <p className="text-sm text-amber-600">
                ${breakEvenRemaining.toLocaleString()} more revenue needed
                {monthsToBreakEven !== null && ` (~${monthsToBreakEven} month${monthsToBreakEven !== 1 ? 's' : ''} at $${monthlyFee.toLocaleString()}/mo)`}
              </p>
            )}
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-slate-50 rounded-lg p-3">
              <p className="text-xs text-slate-500">Furniture Cost</p>
              <p className="text-lg font-bold text-slate-900">${furnitureCost.toLocaleString()}</p>
              <p className="text-xs text-slate-400">{propertyItems.length} items</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-3">
              <p className="text-xs text-slate-500">Other Expenses</p>
              <p className="text-lg font-bold text-slate-900">${totalExpenses.toLocaleString()}</p>
              <p className="text-xs text-slate-400">{expenses.length} entries</p>
            </div>
            <div className="bg-red-50 rounded-lg p-3">
              <p className="text-xs text-red-600">Total Costs</p>
              <p className="text-lg font-bold text-red-700">${totalCosts.toLocaleString()}</p>
            </div>
            <div className="bg-green-50 rounded-lg p-3">
              <p className="text-xs text-green-600">Total Revenue</p>
              <p className="text-lg font-bold text-green-700">${totalRevenue.toLocaleString()}</p>
            </div>
          </div>

          {/* Profit/Loss indicator */}
          <div className={`flex items-center justify-between px-4 py-3 rounded-lg ${profitLoss >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
            <span className="text-sm font-medium text-slate-700">Net Profit / Loss</span>
            <span className={`text-lg font-bold ${profitLoss >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              {profitLoss >= 0 ? '+' : '-'}${Math.abs(profitLoss).toLocaleString()}
            </span>
          </div>

          {/* Furniture retail value */}
          <div className="flex items-center justify-between px-4 py-2 bg-blue-50 rounded-lg">
            <span className="text-xs text-blue-600">Furniture Retail/Replacement Value</span>
            <span className="text-sm font-semibold text-blue-700">${furnitureRetailValue.toLocaleString()}</span>
          </div>

          {/* Expense category breakdown */}
          {expenses.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-slate-500 mb-2">Expenses by Category</h3>
              <div className="space-y-1">
                {EXPENSE_CATEGORIES.filter((c) => expensesByCategory[c.key]).map((c) => (
                  <div key={c.key} className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg text-sm">
                    <span className="text-slate-700">{c.label}</span>
                    <span className="font-medium text-slate-900">${(expensesByCategory[c.key] || 0).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add/Edit expense form */}
          {showAddExpense && (
            <div className="border border-purple-200 bg-purple-50/50 rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-medium text-slate-700">
                {editingExpenseId ? 'Edit Expense' : 'Add Expense'}
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Category</label>
                  <select
                    value={expenseForm.category}
                    onChange={(e) => setExpenseForm({ ...expenseForm, category: e.target.value as ExpenseCategory })}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-purple-500"
                  >
                    {EXPENSE_CATEGORIES.map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Amount ($)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={expenseForm.amount}
                    onChange={(e) => setExpenseForm({ ...expenseForm, amount: +e.target.value })}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-purple-500"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-slate-500 mb-1">Description</label>
                  <input
                    value={expenseForm.description}
                    onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })}
                    placeholder="e.g. ABC Moving Company - initial delivery"
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Date</label>
                  <input
                    type="date"
                    value={expenseForm.expense_date}
                    onChange={(e) => setExpenseForm({ ...expenseForm, expense_date: e.target.value })}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Notes</label>
                  <input
                    value={expenseForm.notes}
                    onChange={(e) => setExpenseForm({ ...expenseForm, notes: e.target.value })}
                    placeholder="Optional notes"
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-purple-500"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={editingExpenseId ? handleUpdateExpense : handleAddExpense}
                  className="px-4 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700"
                >
                  {editingExpenseId ? 'Update Expense' : 'Save Expense'}
                </button>
                <button
                  onClick={() => { setShowAddExpense(false); setEditingExpenseId(null) }}
                  className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Expense line items */}
          {expenses.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-slate-500 mb-2">All Expenses</h3>
              <div className="space-y-1">
                {expenses.map((exp) => (
                  <div key={exp.id} className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg text-sm group">
                    <div>
                      <span className="font-medium text-slate-700">${exp.amount.toLocaleString()}</span>
                      <span className="text-slate-400 mx-2">&middot;</span>
                      <span className="text-slate-500 text-xs">
                        {EXPENSE_CATEGORIES.find((c) => c.key === exp.category)?.label}
                      </span>
                      {exp.description && (
                        <>
                          <span className="text-slate-400 mx-2">&middot;</span>
                          <span className="text-slate-500 text-xs">{exp.description}</span>
                        </>
                      )}
                      {exp.expense_date && (
                        <span className="text-slate-400 text-xs ml-2">
                          {new Date(exp.expense_date).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => startEditExpense(exp)}
                        className="opacity-0 group-hover:opacity-100 text-blue-400 hover:text-blue-600 p-1"
                      >
                        <Edit2 size={12} />
                      </button>
                      <button
                        onClick={() => { if (confirm('Delete this expense?')) deleteExpense(exp.id) }}
                        className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 p-1"
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

      {/* Room Measurements & Fit Checker */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Ruler size={16} className="text-teal-600" />
              Room Measurements
            </h2>
            <div className="flex items-center gap-2">
              {isAIConfigured() && (
                <>
                  <input
                    ref={roomPhotoInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) handleAIRoomMeasure(file)
                      e.target.value = ''
                    }}
                  />
                  <button
                    onClick={() => roomPhotoInputRef.current?.click()}
                    disabled={aiMeasuringRoom}
                    className="flex items-center gap-1 text-xs text-teal-600 hover:text-teal-700 disabled:opacity-50"
                  >
                    {aiMeasuringRoom ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        Measuring...
                      </>
                    ) : (
                      <>
                        <Camera size={14} />
                        AI Measure Room
                      </>
                    )}
                  </button>
                </>
              )}
              <button
                onClick={() => setShowAddRoom(!showAddRoom)}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
              >
                <PlusCircle size={14} />
                Add Room
              </button>
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Measure each room to check which furniture will fit before you move it.
            {isAIConfigured() && ' Tap "AI Measure Room" to snap a photo and auto-estimate dimensions.'}
          </p>

          {aiRoomResult && (
            <div className="flex items-start gap-2 text-xs bg-teal-50 text-teal-700 rounded-lg px-3 py-2">
              <Sparkles size={14} className="flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-medium">AI estimated room ({aiRoomResult.confidence} confidence)</span>
                {aiRoomResult.notes && <span className="text-teal-600"> — {aiRoomResult.notes}</span>}
                <span className="text-teal-600"> Review the values below and save.</span>
              </div>
            </div>
          )}
          {aiRoomError && (
            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{aiRoomError}</p>
          )}

          {/* Add room form */}
          {showAddRoom && (
            <div className="border border-teal-200 bg-teal-50/50 rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-medium text-slate-700">Add Room</h3>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Room Name</label>
                  <input
                    value={roomForm.name}
                    onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })}
                    placeholder="e.g. Living Room"
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-teal-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Length (ft)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={roomForm.length_ft || ''}
                    onChange={(e) => setRoomForm({ ...roomForm, length_ft: e.target.value === '' ? 0 : +e.target.value })}
                    placeholder="ft"
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-teal-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Width (ft)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={roomForm.width_ft || ''}
                    onChange={(e) => setRoomForm({ ...roomForm, width_ft: e.target.value === '' ? 0 : +e.target.value })}
                    placeholder="ft"
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-teal-500"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleAddRoom}
                  disabled={!roomForm.name || !roomForm.length_ft || !roomForm.width_ft}
                  className="px-4 py-2 bg-teal-600 text-white text-sm rounded-lg hover:bg-teal-700 disabled:opacity-50"
                >
                  Save Room
                </button>
                <button
                  onClick={() => setShowAddRoom(false)}
                  className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Room list */}
          {rooms.length > 0 ? (
            <div className="space-y-2">
              {rooms.map((room) => (
                <div key={room.id} className="flex items-center justify-between px-4 py-3 bg-teal-50 rounded-lg group">
                  <div>
                    <span className="text-sm font-medium text-slate-700">{room.name}</span>
                    <span className="text-xs text-teal-600 ml-2">
                      {room.length_ft}' x {room.width_ft}' ({(room.length_ft * room.width_ft).toFixed(0)} sq ft)
                    </span>
                  </div>
                  <button
                    onClick={() => handleDeleteRoom(room.id)}
                    className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 p-1"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-6 bg-slate-50 rounded-lg">
              <Ruler size={28} className="mx-auto text-slate-300 mb-2" />
              <p className="text-xs text-slate-400">No rooms measured yet. Add a room to start checking furniture fit.</p>
            </div>
          )}

          {/* Fit Checker */}
          {rooms.length > 0 && (
            <div className="border-t border-slate-100 pt-4">
              <button
                onClick={() => setShowFitChecker(!showFitChecker)}
                className="flex items-center gap-2 text-sm font-medium text-teal-700 hover:text-teal-800 mb-3"
              >
                {showFitChecker ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                Fit Checker — Will It Fit?
              </button>

              {showFitChecker && (
                <div className="space-y-3">
                  {measuredItems.length === 0 ? (
                    <p className="text-xs text-slate-400 bg-slate-50 rounded-lg p-4 text-center">
                      No items have dimensions recorded. Add measurements to items in inventory to use the fit checker.
                    </p>
                  ) : (
                    rooms.map((room) => {
                      const roomLengthIn = room.length_ft * 12
                      const roomWidthIn = room.width_ft * 12

                      return (
                        <div key={room.id} className="bg-slate-50 rounded-lg p-4">
                          <h4 className="text-sm font-semibold text-slate-700 mb-2">
                            {room.name} <span className="text-xs font-normal text-slate-500">({room.length_ft}' x {room.width_ft}')</span>
                          </h4>
                          <div className="space-y-1">
                            {measuredItems.map((item) => {
                              // Check both orientations (item can be rotated)
                              const fitsNormal =
                                item.length_inches <= roomLengthIn && item.width_inches <= roomWidthIn
                              const fitsRotated =
                                item.width_inches <= roomLengthIn && item.length_inches <= roomWidthIn
                              const fits = fitsNormal || fitsRotated

                              return (
                                <div
                                  key={item.id}
                                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                                    fits ? 'bg-green-50' : 'bg-red-50'
                                  }`}
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    {fits ? (
                                      <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
                                    ) : (
                                      <XCircle size={14} className="text-red-400 flex-shrink-0" />
                                    )}
                                    <span className={`truncate ${fits ? 'text-green-700' : 'text-red-600'}`}>
                                      {item.name}
                                    </span>
                                  </div>
                                  <span className="text-xs text-slate-500 flex-shrink-0 ml-2">
                                    {item.length_inches}" x {item.width_inches}"
                                    {item.height_inches > 0 && ` x ${item.height_inches}"`}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

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
