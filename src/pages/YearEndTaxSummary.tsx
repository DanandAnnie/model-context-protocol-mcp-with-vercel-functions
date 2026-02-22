import { useState, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  FileSpreadsheet, Download, Printer, ChevronDown, ChevronUp,
  DollarSign, TrendingDown, ShoppingCart, AlertCircle,
  Building, Warehouse as WarehouseIcon, Calendar, CreditCard,
  Info, Package, ClipboardList,
} from 'lucide-react'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import { useStorageUnits } from '../hooks/useStorageUnits'
import { usePayments } from '../hooks/usePayments'
import type { Item, PaymentMethod } from '../lib/database.types'

// ─── Constants ───────────────────────────────────────────────────────────────

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  square: 'Square', cash: 'Cash', credit_card: 'Credit Card',
  debit_card: 'Debit Card', venmo: 'Venmo', zelle: 'Zelle',
  paypal: 'PayPal', check: 'Check', other: 'Other',
}

// MACRS 7-year property (most furniture/furnishings) percentages by year
const MACRS_7_YEAR = [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46]
// MACRS 5-year property (computers, appliances, etc.)
const MACRS_5_YEAR = [20.00, 32.00, 19.20, 11.52, 11.52, 5.76]

type DepreciationMethod = 'straight-line' | 'macrs-5' | 'macrs-7'

// ─── Depreciation Calculation ────────────────────────────────────────────────

function calculateDepreciation(item: Item, year: number, method: DepreciationMethod) {
  const purchaseDate = item.purchase_date || item.date_acquired
  if (!purchaseDate) {
    return { currentYear: 0, accumulated: 0, priorAccumulated: 0, bookValue: item.purchase_price || item.value, costBasis: item.purchase_price || item.value }
  }

  const purchaseYear = new Date(purchaseDate).getFullYear()
  const cost = item.purchase_price || item.value
  const yearsOwned = year - purchaseYear

  if (yearsOwned < 0) {
    return { currentYear: 0, accumulated: 0, priorAccumulated: 0, bookValue: cost, costBasis: cost }
  }

  if (method === 'straight-line') {
    const usefulLife = item.useful_life_years || 7
    const annualDep = cost / usefulLife

    if (yearsOwned >= usefulLife) {
      return { currentYear: 0, accumulated: cost, priorAccumulated: cost, bookValue: 0, costBasis: cost }
    }

    // Prorate first year
    const purchaseMonth = new Date(purchaseDate).getMonth()
    const firstYearMonths = 12 - purchaseMonth
    const firstYearDep = (annualDep * firstYearMonths) / 12

    let accumulated = 0
    let priorAccumulated = 0
    let currentYearDep = 0

    if (yearsOwned === 0) {
      currentYearDep = firstYearDep
      accumulated = firstYearDep
      priorAccumulated = 0
    } else {
      priorAccumulated = firstYearDep + annualDep * (yearsOwned - 1)
      priorAccumulated = Math.min(priorAccumulated, cost)
      currentYearDep = priorAccumulated >= cost ? 0 : annualDep
      accumulated = Math.min(priorAccumulated + currentYearDep, cost)
      if (accumulated >= cost) currentYearDep = cost - priorAccumulated
    }

    return {
      currentYear: round(currentYearDep),
      accumulated: round(accumulated),
      priorAccumulated: round(priorAccumulated),
      bookValue: round(Math.max(cost - accumulated, 0)),
      costBasis: cost,
    }
  }

  // MACRS depreciation
  const schedule = method === 'macrs-5' ? MACRS_5_YEAR : MACRS_7_YEAR

  if (yearsOwned >= schedule.length) {
    return { currentYear: 0, accumulated: cost, priorAccumulated: cost, bookValue: 0, costBasis: cost }
  }

  const currentYearDep = cost * (schedule[yearsOwned] / 100)
  let priorAccumulated = 0
  for (let i = 0; i < yearsOwned; i++) {
    priorAccumulated += cost * (schedule[i] / 100)
  }
  const accumulated = priorAccumulated + currentYearDep

  return {
    currentYear: round(currentYearDep),
    accumulated: round(accumulated),
    priorAccumulated: round(priorAccumulated),
    bookValue: round(Math.max(cost - accumulated, 0)),
    costBasis: cost,
  }
}

function round(n: number) {
  return Math.round(n * 100) / 100
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ─── Section 179 limit (2024/2025 IRS limits - update annually)
const SECTION_179_LIMIT = 1_220_000
const SECTION_179_PHASE_OUT = 3_050_000

// ─── Component ───────────────────────────────────────────────────────────────

export default function YearEndTaxSummary() {
  const { items, loading: itemsLoading } = useItems()
  const { properties } = useProperties()
  const { units } = useStorageUnits()
  const { payments } = usePayments()
  const printRef = useRef<HTMLDivElement>(null)

  const currentYear = new Date().getFullYear()
  const [selectedYear, setSelectedYear] = useState(currentYear)
  const [depMethod, setDepMethod] = useState<DepreciationMethod>('macrs-7')
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['summary', 'schedule', 'acquisitions', 'expenses', 'section179'])
  )
  const [businessName, setBusinessName] = useState(
    () => localStorage.getItem('staging-inv-business-name') || 'Staging Business'
  )
  const [editingName, setEditingName] = useState(false)

  const toggleSection = (s: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  // ── Filtered data ──────────────────────────────────────────────────────────

  // All items owned on or before end of selected year
  const taxItems = useMemo(() => {
    return items.filter(item => {
      const date = item.purchase_date || item.date_acquired
      if (!date) return true
      return new Date(date).getFullYear() <= selectedYear
    })
  }, [items, selectedYear])

  // Items purchased in the selected year
  const newAcquisitions = useMemo(() => {
    return items.filter(item => {
      const date = item.purchase_date || item.date_acquired
      if (!date) return false
      return new Date(date).getFullYear() === selectedYear
    })
  }, [items, selectedYear])

  // Retired/disposed items (status = retired or damaged)
  const disposedItems = useMemo(() => {
    return taxItems.filter(item => item.status === 'retired' || item.status === 'damaged')
  }, [taxItems])

  // Active items (available or staged)
  const activeItems = useMemo(() => {
    return taxItems.filter(item => item.status === 'available' || item.status === 'staged')
  }, [taxItems])

  // ── Depreciation calculations ──────────────────────────────────────────────

  const depreciationData = useMemo(() => {
    return taxItems.map(item => ({
      item,
      dep: calculateDepreciation(item, selectedYear, depMethod),
    }))
  }, [taxItems, selectedYear, depMethod])

  const totals = useMemo(() => {
    let totalCostBasis = 0
    let totalCurrentYearDep = 0
    let totalAccumulatedDep = 0
    let totalBookValue = 0

    for (const { dep } of depreciationData) {
      totalCostBasis += dep.costBasis
      totalCurrentYearDep += dep.currentYear
      totalAccumulatedDep += dep.accumulated
      totalBookValue += dep.bookValue
    }

    return {
      costBasis: round(totalCostBasis),
      currentYearDep: round(totalCurrentYearDep),
      accumulatedDep: round(totalAccumulatedDep),
      bookValue: round(totalBookValue),
      itemCount: taxItems.length,
      activeCount: activeItems.length,
      disposedCount: disposedItems.length,
      newCount: newAcquisitions.length,
    }
  }, [depreciationData, taxItems, activeItems, disposedItems, newAcquisitions])

  const newAcquisitionTotal = newAcquisitions.reduce((s, i) => s + (i.purchase_price || i.value), 0)

  // ── Business expenses ──────────────────────────────────────────────────────

  const storageExpenses = useMemo(() => {
    return units.map(unit => ({
      name: `${unit.name} (${unit.unit_number})`,
      address: unit.address,
      monthlyCost: unit.monthly_cost,
      annualCost: unit.monthly_cost * 12,
    }))
  }, [units])

  const totalStorageCost = storageExpenses.reduce((s, e) => s + e.annualCost, 0)

  // Staging payments for the selected year
  const yearPayments = useMemo(() => {
    return payments.filter(p => {
      const pYear = new Date(p.payment_date).getFullYear()
      return pYear === selectedYear
    })
  }, [payments, selectedYear])

  const totalStagingPayments = yearPayments.reduce((s, p) => s + p.amount, 0)

  // Property staging fees (monthly_fee * months active in the year)
  const propertyExpenses = useMemo(() => {
    return properties.map(prop => {
      const startDate = prop.staging_start_date ? new Date(prop.staging_start_date) : null
      if (!startDate || startDate.getFullYear() > selectedYear) return null

      const startMonth = startDate.getFullYear() === selectedYear ? startDate.getMonth() : 0
      const months = 12 - startMonth
      return {
        name: prop.name,
        address: prop.address,
        monthlyFee: prop.monthly_fee,
        monthsActive: months,
        annualCost: prop.monthly_fee * months,
      }
    }).filter(Boolean) as { name: string; address: string; monthlyFee: number; monthsActive: number; annualCost: number }[]
  }, [properties, selectedYear])

  const totalPropertyFees = propertyExpenses.reduce((s, e) => s + e.annualCost, 0)
  const totalBusinessExpenses = totalStorageCost + totalPropertyFees

  // ── Category breakdown ─────────────────────────────────────────────────────

  const categoryBreakdown = useMemo(() => {
    const cats: Record<string, { count: number; costBasis: number; currentDep: number; bookValue: number }> = {}

    for (const { item, dep } of depreciationData) {
      const cat = item.category
      if (!cats[cat]) cats[cat] = { count: 0, costBasis: 0, currentDep: 0, bookValue: 0 }
      cats[cat].count++
      cats[cat].costBasis += dep.costBasis
      cats[cat].currentDep += dep.currentYear
      cats[cat].bookValue += dep.bookValue
    }

    return Object.entries(cats)
      .map(([category, data]) => ({ category, ...data }))
      .sort((a, b) => b.costBasis - a.costBasis)
  }, [depreciationData])

  // ── Section 179 eligibility ────────────────────────────────────────────────

  const section179Eligible = useMemo(() => {
    return newAcquisitions.filter(item => {
      const cost = item.purchase_price || item.value
      return cost > 0 && (item.status === 'available' || item.status === 'staged')
    })
  }, [newAcquisitions])

  const section179Total = section179Eligible.reduce((s, i) => s + (i.purchase_price || i.value), 0)

  // ── Export functions ───────────────────────────────────────────────────────

  const handlePrint = () => {
    window.print()
  }

  const exportFullCSV = () => {
    const methodLabel = depMethod === 'straight-line' ? 'Straight-Line'
      : depMethod === 'macrs-5' ? 'MACRS 5-Year' : 'MACRS 7-Year'

    const sections: string[] = []

    // Header
    sections.push(`"${businessName} - Year End Tax Summary ${selectedYear}"`)
    sections.push(`"Generated: ${new Date().toLocaleDateString()}"`)
    sections.push(`"Depreciation Method: ${methodLabel}"`)
    sections.push('')

    // Executive Summary
    sections.push('"EXECUTIVE SUMMARY"')
    sections.push(`"Total Items","${totals.itemCount}"`)
    sections.push(`"Total Cost Basis","${fmt(totals.costBasis)}"`)
    sections.push(`"${selectedYear} Depreciation Expense","${fmt(totals.currentYearDep)}"`)
    sections.push(`"Total Accumulated Depreciation","${fmt(totals.accumulatedDep)}"`)
    sections.push(`"Net Book Value (End of Year)","${fmt(totals.bookValue)}"`)
    sections.push(`"New Acquisitions (${selectedYear})","${totals.newCount} items - $${fmt(newAcquisitionTotal)}"`)
    sections.push(`"Disposed/Retired Assets","${totals.disposedCount} items"`)
    sections.push('')

    // Full Depreciation Schedule
    sections.push('"DEPRECIATION SCHEDULE"')
    sections.push('"Item Name","Category","Date Acquired","Cost Basis","Useful Life","Depreciation Method","Prior Accumulated Depreciation","Current Year Depreciation","Total Accumulated Depreciation","Net Book Value","Payment Method","Condition","Status","Location"')

    for (const { item, dep } of depreciationData) {
      const location = item.current_property_id
        ? properties.find(p => p.id === item.current_property_id)?.name || 'Property'
        : 'Storage'

      sections.push([
        `"${item.name}"`,
        `"${item.category}"`,
        `"${item.purchase_date || item.date_acquired || 'N/A'}"`,
        `"${fmt(dep.costBasis)}"`,
        `"${item.useful_life_years || 7} years"`,
        `"${methodLabel}"`,
        `"${fmt(dep.priorAccumulated)}"`,
        `"${fmt(dep.currentYear)}"`,
        `"${fmt(dep.accumulated)}"`,
        `"${fmt(dep.bookValue)}"`,
        `"${PAYMENT_LABELS[(item.payment_method || 'other') as PaymentMethod]}"`,
        `"${item.condition}"`,
        `"${item.status}"`,
        `"${location}"`,
      ].join(','))
    }

    sections.push('')
    sections.push(`"TOTALS","","","${fmt(totals.costBasis)}","","","","${fmt(totals.currentYearDep)}","${fmt(totals.accumulatedDep)}","${fmt(totals.bookValue)}","","","",""`)
    sections.push('')

    // Category Summary
    sections.push('"SUMMARY BY CATEGORY"')
    sections.push('"Category","Item Count","Cost Basis","Current Year Depreciation","Book Value"')
    for (const cat of categoryBreakdown) {
      sections.push(`"${cat.category}","${cat.count}","${fmt(cat.costBasis)}","${fmt(cat.currentDep)}","${fmt(cat.bookValue)}"`)
    }
    sections.push('')

    // Business Expenses
    sections.push('"BUSINESS EXPENSES"')
    sections.push('"Storage Unit Expenses"')
    sections.push('"Name","Address","Monthly Cost","Annual Cost"')
    for (const exp of storageExpenses) {
      sections.push(`"${exp.name}","${exp.address}","${fmt(exp.monthlyCost)}","${fmt(exp.annualCost)}"`)
    }
    sections.push(`"Total Storage Expenses","","","${fmt(totalStorageCost)}"`)
    sections.push('')
    sections.push('"Property Staging Fees"')
    sections.push('"Property","Address","Monthly Fee","Months Active","Annual Cost"')
    for (const exp of propertyExpenses) {
      sections.push(`"${exp.name}","${exp.address}","${fmt(exp.monthlyFee)}","${exp.monthsActive}","${fmt(exp.annualCost)}"`)
    }
    sections.push(`"Total Property Fees","","","","${fmt(totalPropertyFees)}"`)
    sections.push('')
    sections.push(`"TOTAL BUSINESS EXPENSES","","","","${fmt(totalBusinessExpenses)}"`)
    sections.push('')

    // Section 179
    sections.push('"SECTION 179 ELIGIBLE ITEMS"')
    sections.push('"Item Name","Date Acquired","Cost"')
    for (const item of section179Eligible) {
      sections.push(`"${item.name}","${item.purchase_date || item.date_acquired || 'N/A'}","${fmt(item.purchase_price || item.value)}"`)
    }
    sections.push(`"Total Section 179 Eligible","","${fmt(section179Total)}"`)

    const blob = new Blob([sections.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${businessName.replace(/\s+/g, '-')}-tax-summary-${selectedYear}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (itemsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  const years = Array.from({ length: 6 }, (_, i) => currentYear - i)
  const methodLabel = depMethod === 'straight-line' ? 'Straight-Line'
    : depMethod === 'macrs-5' ? 'MACRS 5-Year' : 'MACRS 7-Year'

  return (
    <>
      {/* Print-only styles */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .print-area, .print-area * { visibility: visible; }
          .print-area { position: absolute; left: 0; top: 0; width: 100%; padding: 20px; }
          .no-print { display: none !important; }
          .print-break { page-break-before: always; }
          .print-area table { font-size: 10px; }
          .print-area h1 { font-size: 18px; }
          .print-area h2 { font-size: 14px; margin-top: 16px; }
        }
      `}</style>

      <div ref={printRef} className="print-area max-w-5xl mx-auto space-y-6">
        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <FileSpreadsheet size={24} />
              Year End Tax Summary
            </h1>
            <div className="flex items-center gap-2 mt-1">
              {editingName ? (
                <input
                  type="text"
                  value={businessName}
                  onChange={e => setBusinessName(e.target.value)}
                  onBlur={() => { setEditingName(false); localStorage.setItem('staging-inv-business-name', businessName) }}
                  onKeyDown={e => { if (e.key === 'Enter') { setEditingName(false); localStorage.setItem('staging-inv-business-name', businessName) } }}
                  className="px-2 py-0.5 border border-blue-400 rounded text-sm focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              ) : (
                <button
                  onClick={() => setEditingName(true)}
                  className="text-slate-500 text-sm hover:text-blue-600 no-print"
                  title="Click to edit business name"
                >
                  {businessName}
                </button>
              )}
              <span className="text-slate-400 text-sm">|</span>
              <span className="text-slate-500 text-sm">Tax Year {selectedYear}</span>
            </div>
          </div>
          <div className="flex gap-2 no-print">
            <button
              onClick={handlePrint}
              className="flex items-center gap-2 px-3 py-2 bg-slate-100 text-slate-700 text-sm rounded-lg hover:bg-slate-200"
            >
              <Printer size={16} />
              Print
            </button>
            <button
              onClick={exportFullCSV}
              className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700"
            >
              <Download size={16} />
              Export CSV
            </button>
          </div>
        </div>

        {/* ── Controls ──────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row gap-3 no-print">
          <div className="flex-1">
            <label className="block text-xs font-medium text-slate-500 mb-1">Tax Year</label>
            <select
              value={selectedYear}
              onChange={e => setSelectedYear(+e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-slate-500 mb-1">Depreciation Method</label>
            <select
              value={depMethod}
              onChange={e => setDepMethod(e.target.value as DepreciationMethod)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="macrs-7">MACRS 7-Year (Furniture)</option>
              <option value="macrs-5">MACRS 5-Year (Appliances/Tech)</option>
              <option value="straight-line">Straight-Line</option>
            </select>
          </div>
        </div>

        {/* ── Executive Summary ──────────────────────────────────────────── */}
        <CollapsibleSection
          id="summary"
          title="Executive Summary"
          icon={<ClipboardList size={18} />}
          expanded={expandedSections.has('summary')}
          onToggle={() => toggleSection('summary')}
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <SummaryCard icon={<DollarSign size={14} />} label="Total Cost Basis" value={`$${fmt(totals.costBasis)}`} />
            <SummaryCard icon={<TrendingDown size={14} />} label={`${selectedYear} Depreciation`} value={`$${fmt(totals.currentYearDep)}`} valueClass="text-red-600" />
            <SummaryCard icon={<Package size={14} />} label="Net Book Value" value={`$${fmt(totals.bookValue)}`} />
            <SummaryCard icon={<ShoppingCart size={14} />} label={`${selectedYear} Acquisitions`} value={`$${fmt(newAcquisitionTotal)}`} subtitle={`${totals.newCount} items`} valueClass="text-blue-600" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryCard icon={<Package size={14} />} label="Total Assets" value={String(totals.itemCount)} />
            <SummaryCard icon={<Package size={14} />} label="Active Assets" value={String(totals.activeCount)} />
            <SummaryCard icon={<AlertCircle size={14} />} label="Disposed/Retired" value={String(totals.disposedCount)} />
            <SummaryCard icon={<Building size={14} />} label="Total Expenses" value={`$${fmt(totalBusinessExpenses)}`} subtitle="Storage + Fees" valueClass="text-amber-600" />
          </div>

          {/* For the printed report */}
          <div className="mt-4 p-3 bg-slate-50 rounded-lg text-xs text-slate-500">
            <p><strong>Report Generated:</strong> {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
            <p><strong>Depreciation Method:</strong> {methodLabel}</p>
            <p><strong>Tax Year:</strong> {selectedYear}</p>
            <p><strong>Prepared for:</strong> {businessName}</p>
          </div>
        </CollapsibleSection>

        {/* ── Full Depreciation Schedule ─────────────────────────────────── */}
        <CollapsibleSection
          id="schedule"
          title={`Depreciation Schedule (${methodLabel})`}
          icon={<FileSpreadsheet size={18} />}
          expanded={expandedSections.has('schedule')}
          onToggle={() => toggleSection('schedule')}
          count={taxItems.length}
        >
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-xs sm:text-sm">
              <thead>
                <tr className="bg-slate-100 text-left text-xs font-semibold text-slate-600">
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Date Acquired</th>
                  <th className="px-3 py-2 text-right">Cost Basis</th>
                  <th className="px-3 py-2 text-right">Prior Accum.</th>
                  <th className="px-3 py-2 text-right">{selectedYear} Depr.</th>
                  <th className="px-3 py-2 text-right">Total Accum.</th>
                  <th className="px-3 py-2 text-right">Book Value</th>
                  <th className="px-3 py-2 no-print">Status</th>
                </tr>
              </thead>
              <tbody>
                {depreciationData.map(({ item, dep }) => (
                  <tr key={item.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <Link to={`/items/${item.id}`} className="font-medium text-blue-700 hover:underline no-print">{item.name}</Link>
                      <span className="hidden print:inline font-medium">{item.name}</span>
                      <p className="text-xs text-slate-400 capitalize">{item.category}</p>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{item.purchase_date || item.date_acquired || 'N/A'}</td>
                    <td className="px-3 py-2 text-right">${fmt(dep.costBasis)}</td>
                    <td className="px-3 py-2 text-right text-slate-500">${fmt(dep.priorAccumulated)}</td>
                    <td className="px-3 py-2 text-right text-red-600 font-medium">${fmt(dep.currentYear)}</td>
                    <td className="px-3 py-2 text-right text-slate-600">${fmt(dep.accumulated)}</td>
                    <td className="px-3 py-2 text-right font-medium">${fmt(dep.bookValue)}</td>
                    <td className="px-3 py-2 no-print">
                      <StatusBadge status={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-100 font-semibold text-xs border-t-2 border-slate-300">
                  <td className="px-3 py-2" colSpan={2}>TOTALS ({taxItems.length} items)</td>
                  <td className="px-3 py-2 text-right">${fmt(totals.costBasis)}</td>
                  <td className="px-3 py-2 text-right"></td>
                  <td className="px-3 py-2 text-right text-red-600">${fmt(totals.currentYearDep)}</td>
                  <td className="px-3 py-2 text-right">${fmt(totals.accumulatedDep)}</td>
                  <td className="px-3 py-2 text-right">${fmt(totals.bookValue)}</td>
                  <td className="px-3 py-2 no-print"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CollapsibleSection>

        {/* ── New Acquisitions ───────────────────────────────────────────── */}
        <CollapsibleSection
          id="acquisitions"
          title={`${selectedYear} New Acquisitions`}
          icon={<ShoppingCart size={18} />}
          expanded={expandedSections.has('acquisitions')}
          onToggle={() => toggleSection('acquisitions')}
          count={newAcquisitions.length}
        >
          {newAcquisitions.length === 0 ? (
            <p className="text-sm text-slate-400 py-4 text-center">No acquisitions recorded for {selectedYear}</p>
          ) : (
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="w-full text-xs sm:text-sm">
                <thead>
                  <tr className="bg-green-50 text-left text-xs font-semibold text-slate-600">
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Date Purchased</th>
                    <th className="px-3 py-2 text-right">Purchase Price</th>
                    <th className="px-3 py-2">Payment Method</th>
                    <th className="px-3 py-2">Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {newAcquisitions.map(item => (
                    <tr key={item.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2">
                        <Link to={`/items/${item.id}`} className="font-medium text-blue-700 hover:underline no-print">{item.name}</Link>
                        <span className="hidden print:inline font-medium">{item.name}</span>
                        <p className="text-xs text-slate-400 capitalize">{item.category}</p>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{item.purchase_date || item.date_acquired || 'N/A'}</td>
                      <td className="px-3 py-2 text-right font-medium">${fmt(item.purchase_price || item.value)}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                          <CreditCard size={10} />
                          {PAYMENT_LABELS[(item.payment_method || 'other') as PaymentMethod]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {item.receipt_url ? (
                          <span className="text-green-600">On file</span>
                        ) : (
                          <span className="text-amber-500">Missing</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-green-50 font-semibold text-xs border-t-2 border-slate-300">
                    <td className="px-3 py-2" colSpan={2}>TOTAL NEW ACQUISITIONS</td>
                    <td className="px-3 py-2 text-right">${fmt(newAcquisitionTotal)}</td>
                    <td className="px-3 py-2" colSpan={2}>{newAcquisitions.length} items</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CollapsibleSection>

        {/* ── Disposed / Retired Assets ──────────────────────────────────── */}
        {disposedItems.length > 0 && (
          <CollapsibleSection
            id="disposed"
            title="Disposed / Retired Assets"
            icon={<AlertCircle size={18} />}
            expanded={expandedSections.has('disposed')}
            onToggle={() => toggleSection('disposed')}
            count={disposedItems.length}
          >
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="w-full text-xs sm:text-sm">
                <thead>
                  <tr className="bg-red-50 text-left text-xs font-semibold text-slate-600">
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Date Acquired</th>
                    <th className="px-3 py-2 text-right">Cost Basis</th>
                    <th className="px-3 py-2 text-right">Accum. Depr.</th>
                    <th className="px-3 py-2 text-right">Book Value (Loss)</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {disposedItems.map(item => {
                    const dep = calculateDepreciation(item, selectedYear, depMethod)
                    return (
                      <tr key={item.id} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-3 py-2 font-medium">{item.name}</td>
                        <td className="px-3 py-2 text-slate-600">{item.purchase_date || item.date_acquired || 'N/A'}</td>
                        <td className="px-3 py-2 text-right">${fmt(dep.costBasis)}</td>
                        <td className="px-3 py-2 text-right">${fmt(dep.accumulated)}</td>
                        <td className="px-3 py-2 text-right text-red-600 font-medium">${fmt(dep.bookValue)}</td>
                        <td className="px-3 py-2"><StatusBadge status={item.status} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-2 p-3 bg-amber-50 rounded-lg text-xs text-amber-700 flex items-start gap-2">
              <Info size={14} className="mt-0.5 flex-shrink-0" />
              <span>Remaining book value on disposed assets may qualify as a deductible loss. Consult your tax professional for applicable treatment under IRS rules.</span>
            </div>
          </CollapsibleSection>
        )}

        {/* ── Business Expenses ──────────────────────────────────────────── */}
        <CollapsibleSection
          id="expenses"
          title={`${selectedYear} Business Expenses`}
          icon={<Building size={18} />}
          expanded={expandedSections.has('expenses')}
          onToggle={() => toggleSection('expenses')}
        >
          {/* Storage Expenses */}
          <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
            <WarehouseIcon size={14} />
            Storage Unit Rental
          </h3>
          {storageExpenses.length === 0 ? (
            <p className="text-sm text-slate-400 mb-4">No storage units on record</p>
          ) : (
            <div className="overflow-x-auto -mx-4 sm:mx-0 mb-4">
              <table className="w-full text-xs sm:text-sm">
                <thead>
                  <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
                    <th className="px-3 py-2">Storage Unit</th>
                    <th className="px-3 py-2">Address</th>
                    <th className="px-3 py-2 text-right">Monthly Cost</th>
                    <th className="px-3 py-2 text-right">Annual Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {storageExpenses.map((exp, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">{exp.name}</td>
                      <td className="px-3 py-2 text-slate-600">{exp.address}</td>
                      <td className="px-3 py-2 text-right">${fmt(exp.monthlyCost)}</td>
                      <td className="px-3 py-2 text-right font-medium">${fmt(exp.annualCost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-semibold text-xs border-t-2 border-slate-300">
                    <td className="px-3 py-2" colSpan={3}>Total Storage Expenses</td>
                    <td className="px-3 py-2 text-right">${fmt(totalStorageCost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Property Staging Fees */}
          <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
            <Building size={14} />
            Property Staging Fees
          </h3>
          {propertyExpenses.length === 0 ? (
            <p className="text-sm text-slate-400 mb-4">No active staging properties for {selectedYear}</p>
          ) : (
            <div className="overflow-x-auto -mx-4 sm:mx-0 mb-4">
              <table className="w-full text-xs sm:text-sm">
                <thead>
                  <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
                    <th className="px-3 py-2">Property</th>
                    <th className="px-3 py-2">Address</th>
                    <th className="px-3 py-2 text-right">Monthly Fee</th>
                    <th className="px-3 py-2 text-right">Months</th>
                    <th className="px-3 py-2 text-right">Annual Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {propertyExpenses.map((exp, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium">{exp.name}</td>
                      <td className="px-3 py-2 text-slate-600">{exp.address}</td>
                      <td className="px-3 py-2 text-right">${fmt(exp.monthlyFee)}</td>
                      <td className="px-3 py-2 text-right">{exp.monthsActive}</td>
                      <td className="px-3 py-2 text-right font-medium">${fmt(exp.annualCost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-semibold text-xs border-t-2 border-slate-300">
                    <td className="px-3 py-2" colSpan={4}>Total Property Staging Fees</td>
                    <td className="px-3 py-2 text-right">${fmt(totalPropertyFees)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Staging Payments Received */}
          {yearPayments.length > 0 && (
            <>
              <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
                <Calendar size={14} />
                Staging Payments Received ({selectedYear})
              </h3>
              <div className="overflow-x-auto -mx-4 sm:mx-0 mb-4">
                <table className="w-full text-xs sm:text-sm">
                  <thead>
                    <tr className="bg-green-50 text-left text-xs font-semibold text-slate-600">
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Property</th>
                      <th className="px-3 py-2">Month Covered</th>
                      <th className="px-3 py-2">Payment Method</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {yearPayments.map(p => (
                      <tr key={p.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">{p.payment_date}</td>
                        <td className="px-3 py-2">{properties.find(pr => pr.id === p.property_id)?.name || 'Unknown'}</td>
                        <td className="px-3 py-2">{p.month_covered}</td>
                        <td className="px-3 py-2">{PAYMENT_LABELS[(p.payment_method || 'other') as PaymentMethod]}</td>
                        <td className="px-3 py-2 text-right font-medium">${fmt(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-green-50 font-semibold text-xs border-t-2 border-slate-300">
                      <td className="px-3 py-2" colSpan={4}>Total Payments Received</td>
                      <td className="px-3 py-2 text-right">${fmt(totalStagingPayments)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}

          {/* Expense Grand Total */}
          <div className="p-4 bg-amber-50 rounded-lg">
            <div className="flex justify-between items-center">
              <span className="text-sm font-semibold text-amber-800">Total Deductible Business Expenses</span>
              <span className="text-lg font-bold text-amber-800">${fmt(totalBusinessExpenses)}</span>
            </div>
            <p className="text-xs text-amber-600 mt-1">Storage rentals + property staging fees for the year</p>
          </div>
        </CollapsibleSection>

        {/* ── Category Breakdown ─────────────────────────────────────────── */}
        <CollapsibleSection
          id="categories"
          title="Summary by Category"
          icon={<Package size={18} />}
          expanded={expandedSections.has('categories')}
          onToggle={() => toggleSection('categories')}
        >
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-xs sm:text-sm">
              <thead>
                <tr className="bg-slate-100 text-left text-xs font-semibold text-slate-600">
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2 text-right">Items</th>
                  <th className="px-3 py-2 text-right">Cost Basis</th>
                  <th className="px-3 py-2 text-right">{selectedYear} Depreciation</th>
                  <th className="px-3 py-2 text-right">Book Value</th>
                </tr>
              </thead>
              <tbody>
                {categoryBreakdown.map(cat => (
                  <tr key={cat.category} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium capitalize">{cat.category}</td>
                    <td className="px-3 py-2 text-right">{cat.count}</td>
                    <td className="px-3 py-2 text-right">${fmt(cat.costBasis)}</td>
                    <td className="px-3 py-2 text-right text-red-600">${fmt(cat.currentDep)}</td>
                    <td className="px-3 py-2 text-right">${fmt(cat.bookValue)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-100 font-semibold text-xs border-t-2 border-slate-300">
                  <td className="px-3 py-2">TOTALS</td>
                  <td className="px-3 py-2 text-right">{totals.itemCount}</td>
                  <td className="px-3 py-2 text-right">${fmt(totals.costBasis)}</td>
                  <td className="px-3 py-2 text-right text-red-600">${fmt(totals.currentYearDep)}</td>
                  <td className="px-3 py-2 text-right">${fmt(totals.bookValue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CollapsibleSection>

        {/* ── Section 179 Deduction ──────────────────────────────────────── */}
        <CollapsibleSection
          id="section179"
          title="Section 179 & Bonus Depreciation"
          icon={<Info size={18} />}
          expanded={expandedSections.has('section179')}
          onToggle={() => toggleSection('section179')}
        >
          <div className="space-y-4">
            <div className="p-4 bg-blue-50 rounded-lg text-sm text-blue-800">
              <p className="font-semibold mb-2">Section 179 Deduction</p>
              <p className="text-xs mb-2">
                Under Section 179, businesses can deduct the full purchase price of qualifying equipment/furniture purchased during the tax year, instead of depreciating over time.
              </p>
              <div className="grid grid-cols-2 gap-4 mt-3 text-xs">
                <div>
                  <p className="text-blue-600 font-medium">IRS Deduction Limit</p>
                  <p className="text-lg font-bold">${SECTION_179_LIMIT.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-blue-600 font-medium">Phase-Out Threshold</p>
                  <p className="text-lg font-bold">${SECTION_179_PHASE_OUT.toLocaleString()}</p>
                </div>
              </div>
            </div>

            {section179Eligible.length > 0 ? (
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <p className="px-3 text-xs font-semibold text-slate-600 mb-2">
                  Eligible Items (purchased in {selectedYear}):
                </p>
                <table className="w-full text-xs sm:text-sm">
                  <thead>
                    <tr className="bg-blue-50 text-left text-xs font-semibold text-slate-600">
                      <th className="px-3 py-2">Item</th>
                      <th className="px-3 py-2">Category</th>
                      <th className="px-3 py-2">Date Purchased</th>
                      <th className="px-3 py-2 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section179Eligible.map(item => (
                      <tr key={item.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-medium">{item.name}</td>
                        <td className="px-3 py-2 capitalize">{item.category}</td>
                        <td className="px-3 py-2">{item.purchase_date || item.date_acquired || 'N/A'}</td>
                        <td className="px-3 py-2 text-right font-medium">${fmt(item.purchase_price || item.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-blue-50 font-semibold text-xs border-t-2 border-slate-300">
                      <td className="px-3 py-2" colSpan={3}>Total Section 179 Eligible</td>
                      <td className="px-3 py-2 text-right">${fmt(section179Total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <p className="text-sm text-slate-400 py-4 text-center">No eligible items for {selectedYear}</p>
            )}

            <div className="p-3 bg-amber-50 rounded-lg text-xs text-amber-700 flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold">Important Tax Notes:</p>
                <ul className="list-disc ml-4 mt-1 space-y-1">
                  <li>Section 179 applies only to tangible personal property used in your business.</li>
                  <li>The property must be used more than 50% for business purposes.</li>
                  <li>Bonus depreciation (100% first-year) may also apply. Consult your tax advisor.</li>
                  <li>If total equipment placed in service exceeds ${SECTION_179_PHASE_OUT.toLocaleString()}, the deduction is reduced dollar-for-dollar.</li>
                  <li>This report is for informational purposes. Always consult a qualified tax professional.</li>
                </ul>
              </div>
            </div>
          </div>
        </CollapsibleSection>

        {/* ── Tax Professional Notes ─────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 text-xs text-slate-500 print:border-t print:mt-8">
          <p className="font-semibold text-slate-700 mb-2">Notes for Tax Professional</p>
          <ul className="list-disc ml-4 space-y-1">
            <li>All cost basis figures reflect original purchase prices as entered by the business owner.</li>
            <li>Depreciation calculated using {methodLabel} method. Actual tax depreciation may vary based on IRS election.</li>
            <li>Storage and staging fees represent estimated annual costs based on monthly rates and may differ from actual payments.</li>
            <li>Items marked "retired" or "damaged" may qualify for casualty loss or disposition deduction.</li>
            <li>Receipt documentation is noted for each acquisition. Items missing receipts may need additional substantiation.</li>
            <li>This report was generated by Staging Inventory Manager on {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.</li>
          </ul>
        </div>

        {taxItems.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <FileSpreadsheet size={40} className="mx-auto mb-3 opacity-50" />
            <p>No inventory items to report for {selectedYear}</p>
            <Link to="/add-item" className="text-blue-600 text-sm mt-2 inline-block hover:underline">Add your first item</Link>
          </div>
        )}
      </div>
    </>
  )
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function CollapsibleSection({
  title, icon, expanded, onToggle, children, count,
}: {
  id: string; title: string; icon: React.ReactNode; expanded: boolean;
  onToggle: () => void; children: React.ReactNode; count?: number
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition-colors no-print"
      >
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="font-semibold text-sm">{title}</h2>
          {count !== undefined && (
            <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">{count}</span>
          )}
        </div>
        {expanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
      </button>
      {/* Always show in print */}
      <div className={`${expanded ? 'block' : 'hidden'} print:!block border-t border-slate-200 p-4`}>
        {/* Print header (shown only in print when collapsed) */}
        <div className="hidden print:flex items-center gap-2 mb-3">
          {icon}
          <h2 className="font-semibold text-sm">{title}</h2>
        </div>
        {children}
      </div>
    </div>
  )
}

function SummaryCard({
  icon, label, value, subtitle, valueClass = 'text-slate-900',
}: {
  icon: React.ReactNode; label: string; value: string; subtitle?: string; valueClass?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="flex items-center gap-1.5 text-slate-500 text-xs mb-1">{icon}{label}</div>
      <p className={`text-lg font-bold ${valueClass}`}>{value}</p>
      {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    available: 'bg-green-100 text-green-700',
    staged: 'bg-blue-100 text-blue-700',
    damaged: 'bg-red-100 text-red-700',
    retired: 'bg-slate-100 text-slate-500',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${styles[status] || 'bg-slate-100 text-slate-500'}`}>
      {status}
    </span>
  )
}
