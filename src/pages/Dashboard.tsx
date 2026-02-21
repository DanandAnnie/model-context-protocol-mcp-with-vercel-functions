import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Package,
  Home,
  Warehouse,
  DollarSign,
  ArrowRightLeft,
  TrendingUp,
} from 'lucide-react'
import StatsCard from '../components/StatsCard'
import ItemCard from '../components/ItemCard'
import { useItems } from '../hooks/useItems'
import { useProperties } from '../hooks/useProperties'
import { useStorageUnits } from '../hooks/useStorageUnits'

export default function Dashboard() {
  const navigate = useNavigate()
  const { items, loading: itemsLoading } = useItems()
  const { properties, loading: propsLoading } = useProperties()
  const { units, loading: unitsLoading } = useStorageUnits()

  const stats = useMemo(() => {
    const totalValue = items.reduce((sum, i) => sum + i.value, 0)
    const staged = items.filter((i) => i.status === 'staged').length
    const available = items.filter((i) => i.status === 'available').length
    return { totalValue, staged, available, total: items.length }
  }, [items])

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

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Total Items"
          value={stats.total}
          icon={<Package size={20} />}
          subtitle={`${stats.available} available`}
          color="blue"
        />
        <StatsCard
          title="Total Value"
          value={`$${stats.totalValue.toLocaleString()}`}
          icon={<DollarSign size={20} />}
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
          title="Storage Units"
          value={units.length}
          icon={<Warehouse size={20} />}
          subtitle={`$${units.reduce((s, u) => s + u.monthly_cost, 0).toLocaleString()}/mo`}
          color="rose"
        />
      </div>

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
            <p className="text-xs text-slate-500">View stored items</p>
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
