import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  FileText, ChevronDown, ChevronUp, Download, DollarSign,
  TrendingDown, Calendar, CreditCard,
} from 'lucide-react'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import type { Item, PaymentMethod } from '../lib/database.types'

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  square: 'Square',
  cash: 'Cash',
  credit_card: 'Credit Card',
  debit_card: 'Debit Card',
  venmo: 'Venmo',
  zelle: 'Zelle',
  paypal: 'PayPal',
  check: 'Check',
  other: 'Other',
}

function calculateDepreciation(item: Item, year: number) {
  const purchaseDate = item.purchase_date || item.date_acquired
  if (!purchaseDate) return { annualDepreciation: 0, accumulatedDepreciation: 0, bookValue: item.purchase_price }

  const purchaseYear = new Date(purchaseDate).getFullYear()
  const usefulLife = item.useful_life_years || 7
  const cost = item.purchase_price || item.value

  // Straight-line depreciation
  const annualDepreciation = cost / usefulLife
  const yearsOwned = year - purchaseYear

  if (yearsOwned < 0) return { annualDepreciation: 0, accumulatedDepreciation: 0, bookValue: cost }
  if (yearsOwned >= usefulLife) return { annualDepreciation: 0, accumulatedDepreciation: cost, bookValue: 0 }

  // For the purchase year, prorate based on months remaining
  const purchaseMonth = new Date(purchaseDate).getMonth()
  const firstYearMonths = 12 - purchaseMonth
  const firstYearDepreciation = (annualDepreciation * firstYearMonths) / 12

  let accumulated = 0
  if (yearsOwned === 0) {
    accumulated = firstYearDepreciation
  } else {
    accumulated = firstYearDepreciation + annualDepreciation * Math.min(yearsOwned - 1, usefulLife - 1)
    // Last partial year if needed
    if (yearsOwned < usefulLife) {
      accumulated += annualDepreciation
    }
  }

  accumulated = Math.min(accumulated, cost)
  const currentYearDep = yearsOwned === 0 ? firstYearDepreciation : (accumulated < cost ? annualDepreciation : 0)
  const bookValue = Math.max(cost - accumulated, 0)

  return {
    annualDepreciation: Math.round(currentYearDep * 100) / 100,
    accumulatedDepreciation: Math.round(accumulated * 100) / 100,
    bookValue: Math.round(bookValue * 100) / 100,
  }
}

export default function TaxReport() {
  const { items, loading } = useItems()
  const { properties } = useProperties()
  const currentYear = new Date().getFullYear()
  const [selectedYear, setSelectedYear] = useState(currentYear)
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null)
  const [groupBy, setGroupBy] = useState<'category' | 'property' | 'payment'>('category')

  // Items that have a purchase date in or before the selected year
  const taxItems = useMemo(() => {
    return items.filter((item) => {
      const purchaseDate = item.purchase_date || item.date_acquired
      if (!purchaseDate) return true // include items without date (user can fill in)
      return new Date(purchaseDate).getFullYear() <= selectedYear
    })
  }, [items, selectedYear])

  // Items purchased in the selected year specifically
  const purchasedThisYear = useMemo(() => {
    return items.filter((item) => {
      const purchaseDate = item.purchase_date || item.date_acquired
      if (!purchaseDate) return false
      return new Date(purchaseDate).getFullYear() === selectedYear
    })
  }, [items, selectedYear])

  // Group items
  const grouped = useMemo(() => {
    const groups: Record<string, { label: string; items: Item[] }> = {}

    for (const item of taxItems) {
      let key: string
      let label: string

      if (groupBy === 'category') {
        key = item.category
        label = item.category.charAt(0).toUpperCase() + item.category.slice(1)
      } else if (groupBy === 'property') {
        if (item.current_property_id) {
          key = item.current_property_id
          label = properties.find((p) => p.id === item.current_property_id)?.name || 'Unknown Property'
        } else {
          key = '_storage'
          label = 'In Storage'
        }
      } else {
        key = item.payment_method || 'other'
        label = PAYMENT_LABELS[(item.payment_method || 'other') as PaymentMethod] || 'Other'
      }

      if (!groups[key]) groups[key] = { label, items: [] }
      groups[key].items.push(item)
    }

    return Object.entries(groups).sort(([, a], [, b]) => a.label.localeCompare(b.label))
  }, [taxItems, groupBy, properties])

  // Totals
  const totals = useMemo(() => {
    let totalPurchasePrice = 0
    let totalCurrentValue = 0
    let totalDepreciation = 0
    let totalBookValue = 0

    for (const item of taxItems) {
      const dep = calculateDepreciation(item, selectedYear)
      totalPurchasePrice += item.purchase_price || item.value
      totalCurrentValue += item.value
      totalDepreciation += dep.annualDepreciation
      totalBookValue += dep.bookValue
    }

    return {
      totalPurchasePrice: Math.round(totalPurchasePrice * 100) / 100,
      totalCurrentValue: Math.round(totalCurrentValue * 100) / 100,
      totalDepreciation: Math.round(totalDepreciation * 100) / 100,
      totalBookValue: Math.round(totalBookValue * 100) / 100,
    }
  }, [taxItems, selectedYear])

  const newPurchaseTotal = purchasedThisYear.reduce((sum, i) => sum + (i.purchase_price || i.value), 0)

  // CSV export
  const exportCSV = () => {
    const headers = [
      'Item Name', 'Category', 'Purchase Date', 'Purchase Price',
      'Payment Method', 'Current Value', 'Useful Life (yrs)',
      `${selectedYear} Depreciation`, 'Accumulated Depreciation', 'Book Value',
      'Location', 'Condition', 'Status',
    ]

    const rows = taxItems.map((item) => {
      const dep = calculateDepreciation(item, selectedYear)
      const location = item.current_property_id
        ? properties.find((p) => p.id === item.current_property_id)?.name || 'Property'
        : 'Storage'

      return [
        item.name,
        item.category,
        item.purchase_date || item.date_acquired || '',
        (item.purchase_price || item.value).toFixed(2),
        PAYMENT_LABELS[(item.payment_method || 'other') as PaymentMethod],
        item.value.toFixed(2),
        item.useful_life_years || 7,
        dep.annualDepreciation.toFixed(2),
        dep.accumulatedDepreciation.toFixed(2),
        dep.bookValue.toFixed(2),
        location,
        item.condition,
        item.status,
      ]
    })

    const csv = [
      headers.join(','),
      ...rows.map((r) => r.map((v) => `"${v}"`).join(',')),
      '',
      `"Total Purchase Price","","","${totals.totalPurchasePrice.toFixed(2)}"`,
      `"Total ${selectedYear} Depreciation","","","${totals.totalDepreciation.toFixed(2)}"`,
      `"Total Book Value","","","${totals.totalBookValue.toFixed(2)}"`,
    ].join('\n')

    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tax-depreciation-report-${selectedYear}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  const years = Array.from({ length: 5 }, (_, i) => currentYear - i)

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText size={24} />
            Tax & Depreciation Report
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Itemized inventory for tax purposes
          </p>
        </div>
        <button
          onClick={exportCSV}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700"
        >
          <Download size={16} />
          Export CSV
        </button>
      </div>

      {/* Year selector & group by */}
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-500 mb-1">Tax Year</label>
          <select
            value={selectedYear}
            onChange={(e) => setSelectedYear(+e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-500 mb-1">Group By</label>
          <select
            value={groupBy}
            onChange={(e) => { setGroupBy(e.target.value as 'category' | 'property' | 'payment'); setExpandedCategory(null) }}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="category">Category</option>
            <option value="property">Property</option>
            <option value="payment">Payment Method</option>
          </select>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
            <DollarSign size={14} />
            Total Cost Basis
          </div>
          <p className="text-lg font-bold text-slate-900">${totals.totalPurchasePrice.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
            <TrendingDown size={14} />
            {selectedYear} Depreciation
          </div>
          <p className="text-lg font-bold text-red-600">${totals.totalDepreciation.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
            <FileText size={14} />
            Book Value
          </div>
          <p className="text-lg font-bold text-slate-900">${totals.totalBookValue.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
            <Calendar size={14} />
            {selectedYear} Purchases
          </div>
          <p className="text-lg font-bold text-blue-600">${Math.round(newPurchaseTotal).toLocaleString()}</p>
          <p className="text-xs text-slate-400">{purchasedThisYear.length} items</p>
        </div>
      </div>

      {/* Grouped items */}
      <div className="space-y-3">
        {grouped.map(([key, group]) => {
          const isExpanded = expandedCategory === key
          const groupDepreciation = group.items.reduce((sum, item) => {
            return sum + calculateDepreciation(item, selectedYear).annualDepreciation
          }, 0)
          const groupCost = group.items.reduce((sum, item) => sum + (item.purchase_price || item.value), 0)

          return (
            <div key={key} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <button
                onClick={() => setExpandedCategory(isExpanded ? null : key)}
                className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="text-left">
                    <p className="font-medium text-sm capitalize">{group.label}</p>
                    <p className="text-xs text-slate-500">{group.items.length} items</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-sm font-medium">${Math.round(groupCost).toLocaleString()}</p>
                    <p className="text-xs text-red-500">-${Math.round(groupDepreciation).toLocaleString()} dep.</p>
                  </div>
                  {isExpanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-slate-200">
                  {/* Table header */}
                  <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-slate-50 text-xs font-medium text-slate-500">
                    <div className="col-span-4">Item</div>
                    <div className="col-span-2 text-right">Cost</div>
                    <div className="col-span-2 text-right">Depr.</div>
                    <div className="col-span-2 text-right">Book Value</div>
                    <div className="col-span-2 text-right">Payment</div>
                  </div>
                  {group.items.map((item) => {
                    const dep = calculateDepreciation(item, selectedYear)
                    return (
                      <Link
                        key={item.id}
                        to={`/items/${item.id}`}
                        className="grid grid-cols-12 gap-2 px-4 py-3 border-t border-slate-100 hover:bg-slate-50 text-sm items-center"
                      >
                        <div className="col-span-4">
                          <p className="font-medium text-slate-900 truncate">{item.name}</p>
                          <p className="text-xs text-slate-400">{item.purchase_date || item.date_acquired || 'No date'}</p>
                        </div>
                        <div className="col-span-2 text-right text-slate-700">
                          ${(item.purchase_price || item.value).toLocaleString()}
                        </div>
                        <div className="col-span-2 text-right text-red-500">
                          -${dep.annualDepreciation.toLocaleString()}
                        </div>
                        <div className="col-span-2 text-right text-slate-700">
                          ${dep.bookValue.toLocaleString()}
                        </div>
                        <div className="col-span-2 text-right">
                          <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                            <CreditCard size={10} />
                            {PAYMENT_LABELS[(item.payment_method || 'other') as PaymentMethod]}
                          </span>
                        </div>
                      </Link>
                    )
                  })}
                  {/* Group subtotal */}
                  <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-slate-50 border-t border-slate-200 text-xs font-semibold text-slate-600">
                    <div className="col-span-4">Subtotal</div>
                    <div className="col-span-2 text-right">${Math.round(groupCost).toLocaleString()}</div>
                    <div className="col-span-2 text-right text-red-500">-${Math.round(groupDepreciation).toLocaleString()}</div>
                    <div className="col-span-2 text-right">
                      ${Math.round(group.items.reduce((sum, item) => sum + calculateDepreciation(item, selectedYear).bookValue, 0)).toLocaleString()}
                    </div>
                    <div className="col-span-2" />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {taxItems.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <FileText size={40} className="mx-auto mb-3 opacity-50" />
          <p>No items to report for {selectedYear}</p>
        </div>
      )}
    </div>
  )
}
