import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Package,
  Home,
  Warehouse,
  DollarSign,
  ArrowRightLeft,
  TrendingUp,
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Clock,
  CreditCard,
} from 'lucide-react'
import StatsCard from '../components/StatsCard'
import ItemCard from '../components/ItemCard'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import { useStorageUnits } from '../hooks/useStorageUnits'
import { usePayments } from '../hooks/usePayments'
import { usePropertyExpenses } from '../hooks/usePropertyExpenses'

export default function Dashboard() {
  const navigate = useNavigate()
  const { items, loading: itemsLoading } = useItems()
  const { properties, loading: propsLoading } = useProperties()
  const { units, loading: unitsLoading } = useStorageUnits()
  const { payments } = usePayments()
  const { expenses } = usePropertyExpenses()

  const stats = useMemo(() => {
    const totalValue = items.reduce((sum, i) => sum + i.value, 0)
    const totalCost = items.reduce((sum, i) => sum + (i.purchase_price || i.value), 0)
    const staged = items.filter((i) => i.status === 'staged').length
    const available = items.filter((i) => i.status === 'available').length
    const damaged = items.filter((i) => i.status === 'damaged').length
    return { totalValue, totalCost, staged, available, damaged, total: items.length }
  }, [items])

  // Overdue payment detection
  const overdueProperties = useMemo(() => {
    const now = new Date()
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

    return properties
      .filter((p) => p.monthly_fee > 0 && p.staging_start_date)
      .map((p) => {
        const start = new Date(p.staging_start_date!)
        const unpaidMonths: string[] = []
        const cursor = new Date(start.getFullYear(), start.getMonth(), 1)

        while (cursor <= now) {
          const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`
          const paid = payments.some(
            (pay) => pay.property_id === p.id && pay.month_covered === key,
          )
          if (!paid && key <= currentMonthKey) {
            unpaidMonths.push(key)
          }
          cursor.setMonth(cursor.getMonth() + 1)
        }

        return { property: p, unpaidMonths, amountOwed: unpaidMonths.length * p.monthly_fee }
      })
      .filter((o) => o.unpaidMonths.length > 0)
      .sort((a, b) => b.amountOwed - a.amountOwed)
  }, [properties, payments])

  // Per-property profitability
  const propertyProfitability = useMemo(() => {
    return properties
      .filter((p) => p.monthly_fee > 0)
      .map((p) => {
        const propertyItems = items.filter((i) => i.current_property_id === p.id)
        const furnitureCost = propertyItems.reduce((sum, i) => sum + (i.purchase_price || 0), 0)
        const propertyExpenses = expenses.filter((e) => e.property_id === p.id)
        const totalExpense = propertyExpenses.reduce((sum, e) => sum + e.amount, 0)
        const totalCost = furnitureCost + totalExpense
        const totalRevenue = payments
          .filter((pay) => pay.property_id === p.id)
          .reduce((sum, pay) => sum + pay.amount, 0)

        return {
          property: p,
          itemCount: propertyItems.length,
          totalCost,
          totalRevenue,
          profitLoss: totalRevenue - totalCost,
          breakEven: totalRevenue >= totalCost,
        }
      })
      .sort((a, b) => b.profitLoss - a.profitLoss)
  }, [properties, items, payments, expenses])

  // Condition breakdown
  const conditionBreakdown = useMemo(() => {
    const counts = { excellent: 0, good: 0, fair: 0, poor: 0 }
    for (const item of items) {
      if (item.condition in counts) {
        counts[item.condition as keyof typeof counts]++
      }
    }
    return counts
  }, [items])

  // Financial totals
  const financials = useMemo(() => {
    const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0)
    const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0)
    const monthlyStorageCost = units.reduce((s, u) => s + u.monthly_cost, 0)
    const monthlyFeeIncome = properties.reduce((s, p) => s + (p.monthly_fee || 0), 0)
    return { totalRevenue, totalExpenses, monthlyStorageCost, monthlyFeeIncome }
  }, [payments, expenses, units, properties])

  const locationName = (item: typeof items[0]) => {
    if (item.current_location_type === 'property') {
      return properties.find((p) => p.id === item.current_property_id)?.name || 'Property'
    }
    return units.find((u) => u.id === item.current_storage_id)?.name || 'Storage'
  }

  const recentItems = useMemo(
    () => [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5),
    [items],
  )

  const loading = itemsLoading || propsLoading || unitsLoading

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-slate-500 text-sm mt-1">Overview of your staging inventory</p>
      </div>

      {/* Overdue payment alerts */}
      {overdueProperties.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertCircle size={18} className="text-red-600" />
            <h2 className="text-sm font-semibold text-red-800">
              Overdue Payments ({overdueProperties.length})
            </h2>
          </div>
          <div className="space-y-2">
            {overdueProperties.slice(0, 3).map(({ property, unpaidMonths, amountOwed }) => (
              <Link
                key={property.id}
                to={`/properties/${property.id}`}
                className="flex items-center justify-between px-3 py-2 bg-white rounded-lg border border-red-100 hover:border-red-300 transition-colors"
              >
                <div>
                  <p className="text-sm font-medium text-slate-900">{property.name}</p>
                  <p className="text-xs text-red-600">
                    {unpaidMonths.length} month{unpaidMonths.length !== 1 ? 's' : ''} overdue
                  </p>
                </div>
                <span className="text-sm font-bold text-red-700">${amountOwed.toLocaleString()}</span>
              </Link>
            ))}
            {overdueProperties.length > 3 && (
              <p className="text-xs text-red-600 text-center">
                +{overdueProperties.length - 3} more properties with overdue payments
              </p>
            )}
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Total Items"
          value={stats.total}
          icon={<Package size={20} />}
          subtitle={`${stats.available} available · ${stats.damaged} damaged`}
          color="blue"
        />
        <StatsCard
          title="Portfolio Value"
          value={`$${stats.totalValue.toLocaleString()}`}
          icon={<DollarSign size={20} />}
          subtitle={`$${stats.totalCost.toLocaleString()} cost basis`}
          color="green"
        />
        <StatsCard
          title="Items Staged"
          value={stats.staged}
          icon={<ArrowRightLeft size={20} />}
          subtitle={`across ${properties.length} properties`}
          color="amber"
        />
        <StatsCard
          title="Revenue Collected"
          value={`$${financials.totalRevenue.toLocaleString()}`}
          icon={<CreditCard size={20} />}
          subtitle={`$${financials.monthlyFeeIncome.toLocaleString()}/mo expected`}
          color="rose"
        />
      </div>

      {/* Financial overview + Condition breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Monthly snapshot */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <BarChart3 size={16} className="text-blue-600" />
            Financial Overview
          </h2>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm text-slate-600">Monthly staging fees</span>
              <span className="text-sm font-medium text-green-700">
                +${financials.monthlyFeeIncome.toLocaleString()}/mo
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-slate-600">Monthly storage costs</span>
              <span className="text-sm font-medium text-red-600">
                -${financials.monthlyStorageCost.toLocaleString()}/mo
              </span>
            </div>
            <div className="border-t border-slate-100 pt-2 flex justify-between items-center">
              <span className="text-sm font-medium text-slate-700">Net monthly</span>
              <span className={`text-sm font-bold ${financials.monthlyFeeIncome - financials.monthlyStorageCost >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                {financials.monthlyFeeIncome - financials.monthlyStorageCost >= 0 ? '+' : '-'}$
                {Math.abs(financials.monthlyFeeIncome - financials.monthlyStorageCost).toLocaleString()}/mo
              </span>
            </div>
            <div className="border-t border-slate-100 pt-2 space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-500">Total revenue collected</span>
                <span className="text-xs font-medium text-slate-700">${financials.totalRevenue.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-500">Total business expenses</span>
                <span className="text-xs font-medium text-slate-700">${financials.totalExpenses.toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Condition breakdown */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Package size={16} className="text-blue-600" />
            Inventory Condition
          </h2>
          <div className="space-y-2">
            {(
              [
                { key: 'excellent', label: 'Excellent', color: 'bg-green-500', textColor: 'text-green-700' },
                { key: 'good', label: 'Good', color: 'bg-blue-500', textColor: 'text-blue-700' },
                { key: 'fair', label: 'Fair', color: 'bg-amber-500', textColor: 'text-amber-700' },
                { key: 'poor', label: 'Poor', color: 'bg-red-500', textColor: 'text-red-700' },
              ] as const
            ).map((c) => {
              const count = conditionBreakdown[c.key]
              const pct = stats.total > 0 ? (count / stats.total) * 100 : 0
              return (
                <div key={c.key}>
                  <div className="flex justify-between items-center mb-1">
                    <span className={`text-xs font-medium ${c.textColor}`}>{c.label}</span>
                    <span className="text-xs text-slate-500">{count} ({Math.round(pct)}%)</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-2">
                    <div className={`${c.color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Property profitability */}
      {propertyProfitability.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <TrendingUp size={16} className="text-green-600" />
            Property Profitability
          </h2>
          <div className="space-y-2">
            {propertyProfitability.map(({ property, itemCount, totalCost, totalRevenue, profitLoss, breakEven }) => (
              <Link
                key={property.id}
                to={`/properties/${property.id}`}
                className="flex items-center justify-between px-3 py-2.5 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <div className="flex items-center gap-3">
                  {breakEven ? (
                    <CheckCircle2 size={16} className="text-green-500 flex-shrink-0" />
                  ) : (
                    <Clock size={16} className="text-amber-500 flex-shrink-0" />
                  )}
                  <div>
                    <p className="text-sm font-medium text-slate-900">{property.name}</p>
                    <p className="text-xs text-slate-500">
                      {itemCount} items · ${totalCost.toLocaleString()} invested · ${totalRevenue.toLocaleString()} earned
                    </p>
                  </div>
                </div>
                <span className={`text-sm font-bold ${profitLoss >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                  {profitLoss >= 0 ? '+' : '-'}${Math.abs(profitLoss).toLocaleString()}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Quick links */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link
          to="/properties"
          className="flex items-center gap-4 p-4 bg-white rounded-xl border border-slate-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="p-3 bg-blue-50 rounded-lg">
            <Home size={20} className="text-blue-700" />
          </div>
          <div>
            <p className="font-medium">{properties.length} Properties</p>
            <p className="text-xs text-slate-500">View and manage properties</p>
          </div>
        </Link>
        <Link
          to="/storage"
          className="flex items-center gap-4 p-4 bg-white rounded-xl border border-slate-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="p-3 bg-amber-50 rounded-lg">
            <Warehouse size={20} className="text-amber-700" />
          </div>
          <div>
            <p className="font-medium">{units.length} Storage Units</p>
            <p className="text-xs text-slate-500">${units.reduce((s, u) => s + u.monthly_cost, 0).toLocaleString()}/mo</p>
          </div>
        </Link>
        <Link
          to="/staging-planner"
          className="flex items-center gap-4 p-4 bg-white rounded-xl border border-slate-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="p-3 bg-green-50 rounded-lg">
            <TrendingUp size={20} className="text-green-700" />
          </div>
          <div>
            <p className="font-medium">Staging Planner</p>
            <p className="text-xs text-slate-500">Drag & drop items to stage</p>
          </div>
        </Link>
      </div>

      {/* Recent activity */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Recent Items</h2>
          <Link to="/inventory" className="text-sm text-blue-600 hover:text-blue-700">
            View all
          </Link>
        </div>
        <div className="space-y-2">
          {recentItems.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              locationName={locationName(item)}
              onClick={() => navigate(`/items/${item.id}`)}
            />
          ))}
          {recentItems.length === 0 && (
            <p className="text-slate-400 text-sm py-8 text-center">No items yet</p>
          )}
        </div>
      </div>
    </div>
  )
}
