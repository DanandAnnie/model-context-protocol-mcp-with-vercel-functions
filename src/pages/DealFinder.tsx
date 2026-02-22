import { useState, useMemo } from 'react'
import {
  Search, Bell, BellOff, PlusCircle, Trash2, ExternalLink, Bookmark, BookmarkCheck,
  RefreshCw, Tag, DollarSign, Filter,
  ShoppingCart, Eye, EyeOff, Clock, Zap,
} from 'lucide-react'
import { useDeals } from '../hooks/useDeals'
import type { DealWatchInsert } from '../lib/database.types'

const CATEGORIES: { key: string; label: string }[] = [
  { key: '', label: 'All Categories' },
  { key: 'living room', label: 'Living Room' },
  { key: 'bedroom', label: 'Bedroom' },
  { key: 'kitchen & dining', label: 'Kitchen & Dining' },
  { key: 'office', label: 'Office' },
  { key: 'bathroom', label: 'Bathroom' },
  { key: 'outdoor', label: 'Outdoor' },
  { key: 'other', label: 'Other' },
]

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export default function DealFinder() {
  const {
    deals, savedDeals, watches, loading, scanning, lastScanAt,
    scanDeals, addWatch, updateWatch, deleteWatch, updateDeal, cleanupDeals,
  } = useDeals()

  // Tab state
  const [activeTab, setActiveTab] = useState<'deals' | 'saved' | 'watches'>('deals')

  // Filter state
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [minDiscount, setMinDiscount] = useState(0)
  const [maxPrice, setMaxPrice] = useState(0)
  const [showFilters, setShowFilters] = useState(false)

  // Watch form
  const [showAddWatch, setShowAddWatch] = useState(false)
  const [watchForm, setWatchForm] = useState<DealWatchInsert>({
    keywords: '',
    category: '',
    max_price: 0,
    min_discount: 0,
    sources: [],
    notify: true,
    active: true,
  })

  // Notification permission
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  )

  const requestNotifications = async () => {
    if ('Notification' in window) {
      const perm = await Notification.requestPermission()
      setNotifPermission(perm)
    }
  }

  // Scan handler
  const [scanResult, setScanResult] = useState<{ newCount: number; total: number } | null>(null)

  const handleScan = async () => {
    setScanResult(null)
    const result = await scanDeals()
    setScanResult(result)
    setTimeout(() => setScanResult(null), 8000)
  }

  // Filtered deals
  const filtered = useMemo(() => {
    let result = activeTab === 'saved' ? savedDeals : deals

    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.description.toLowerCase().includes(q) ||
          d.retailer.toLowerCase().includes(q),
      )
    }

    if (categoryFilter) {
      result = result.filter((d) => d.category === categoryFilter)
    }

    if (minDiscount > 0) {
      result = result.filter((d) => d.discount_percent >= minDiscount)
    }

    if (maxPrice > 0) {
      result = result.filter((d) => d.sale_price <= maxPrice && d.sale_price > 0)
    }

    return result
  }, [deals, savedDeals, activeTab, search, categoryFilter, minDiscount, maxPrice])

  // Watch form handlers
  const handleAddWatch = async () => {
    if (!watchForm.keywords && !watchForm.category) return
    await addWatch(watchForm)
    setWatchForm({
      keywords: '',
      category: '',
      max_price: 0,
      min_discount: 0,
      sources: [],
      notify: true,
      active: true,
    })
    setShowAddWatch(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Zap size={24} className="text-amber-500" />
            Deal Finder
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Scan for discounted furniture deals across retailers
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Notification toggle */}
          {notifPermission !== 'granted' ? (
            <button
              onClick={requestNotifications}
              className="flex items-center gap-1.5 px-3 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50"
              title="Enable deal alerts"
            >
              <BellOff size={16} className="text-slate-400" />
              <span className="hidden sm:inline">Enable Alerts</span>
            </button>
          ) : (
            <div className="flex items-center gap-1.5 px-3 py-2 text-sm text-green-600 bg-green-50 rounded-lg border border-green-200">
              <Bell size={16} />
              <span className="hidden sm:inline">Alerts On</span>
            </div>
          )}

          {/* Scan button */}
          <button
            onClick={handleScan}
            disabled={scanning}
            className="flex items-center gap-2 px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 disabled:opacity-50"
          >
            <RefreshCw size={16} className={scanning ? 'animate-spin' : ''} />
            {scanning ? 'Scanning...' : 'Scan Now'}
          </button>
        </div>
      </div>

      {/* Scan result banner */}
      {scanResult && (
        <div className={`rounded-lg p-3 text-sm flex items-center gap-2 ${
          scanResult.newCount > 0
            ? 'bg-green-50 text-green-700 border border-green-200'
            : 'bg-slate-50 text-slate-600 border border-slate-200'
        }`}>
          {scanResult.newCount > 0 ? (
            <span>Found <strong>{scanResult.newCount} new deals</strong> out of {scanResult.total} scanned!</span>
          ) : scanResult.total > 0 ? (
            <span>Scan complete — no new deals since last scan. Checked {scanResult.total} listings.</span>
          ) : (
            <span>Scan complete. Set up watches in the Watchlist tab to find targeted deals, or try again in a moment.</span>
          )}
        </div>
      )}

      {/* Last scan info */}
      {lastScanAt && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Clock size={12} />
          Last scanned: {timeAgo(lastScanAt)}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-slate-200">
        {(
          [
            { key: 'deals', label: 'All Deals', count: deals.length },
            { key: 'saved', label: 'Saved', count: savedDeals.length },
            { key: 'watches', label: 'Watchlist', count: watches.length },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-slate-100 text-slate-500 rounded-full">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Deals + Saved tabs content */}
      {(activeTab === 'deals' || activeTab === 'saved') && (
        <>
          {/* Search + filters */}
          <div className="flex gap-3">
            <div className="flex-1 relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search deals by name, retailer..."
                className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm border ${
                showFilters ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-300 text-slate-600'
              }`}
            >
              <Filter size={16} />
              Filters
            </button>
          </div>

          {showFilters && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 grid grid-cols-2 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Category</label>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Min Discount %</label>
                <input
                  type="number"
                  min={0}
                  max={99}
                  value={minDiscount || ''}
                  onChange={(e) => setMinDiscount(+e.target.value)}
                  placeholder="e.g. 20"
                  className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Max Price ($)</label>
                <input
                  type="number"
                  min={0}
                  value={maxPrice || ''}
                  onChange={(e) => setMaxPrice(+e.target.value)}
                  placeholder="e.g. 500"
                  className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                />
              </div>
            </div>
          )}

          {/* Deal cards */}
          <div className="space-y-3">
            {filtered.map((deal) => (
              <div
                key={deal.id}
                className={`bg-white rounded-xl border p-4 hover:shadow-sm transition-shadow ${
                  deal.is_saved ? 'border-amber-300' : 'border-slate-200'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {deal.discount_percent >= 40 && (
                        <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded">
                          HOT
                        </span>
                      )}
                      {deal.discount_percent > 0 && (
                        <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-xs font-semibold rounded">
                          -{deal.discount_percent}%
                        </span>
                      )}
                      <span className="text-xs text-slate-400 capitalize">{deal.category}</span>
                      <span className="text-xs text-slate-300">&middot;</span>
                      <span className="text-xs text-slate-500">{deal.retailer}</span>
                    </div>
                    <h3 className="text-sm font-medium text-slate-900 line-clamp-2">{deal.title}</h3>
                    {deal.description && (
                      <p className="text-xs text-slate-500 mt-1 line-clamp-2">{deal.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2">
                      {deal.sale_price > 0 && (
                        <span className="text-lg font-bold text-green-700">${deal.sale_price.toLocaleString()}</span>
                      )}
                      {deal.original_price > 0 && deal.original_price !== deal.sale_price && (
                        <span className="text-sm text-slate-400 line-through">${deal.original_price.toLocaleString()}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-slate-400">{timeAgo(deal.found_at)}</span>
                    </div>
                  </div>

                  {/* Deal image placeholder */}
                  {deal.image_url ? (
                    <img src={deal.image_url} alt="" className="w-20 h-20 rounded-lg object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-20 h-20 bg-slate-100 rounded-lg flex items-center justify-center flex-shrink-0">
                      <ShoppingCart size={24} className="text-slate-300" />
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100">
                  {deal.source_url && (
                    <a
                      href={deal.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700"
                    >
                      <ExternalLink size={12} />
                      View Deal
                    </a>
                  )}
                  <button
                    onClick={() => updateDeal(deal.id, { is_saved: !deal.is_saved })}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border ${
                      deal.is_saved
                        ? 'bg-amber-50 border-amber-300 text-amber-700'
                        : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {deal.is_saved ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
                    {deal.is_saved ? 'Saved' : 'Save'}
                  </button>
                  <button
                    onClick={() => updateDeal(deal.id, { is_dismissed: true })}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-lg border border-slate-200"
                  >
                    <EyeOff size={12} />
                    Dismiss
                  </button>
                </div>
              </div>
            ))}

            {filtered.length === 0 && (
              <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
                <ShoppingCart size={40} className="mx-auto text-slate-300 mb-3" />
                <p className="text-slate-500 text-sm">
                  {activeTab === 'saved' ? 'No saved deals yet' : 'No deals found'}
                </p>
                <p className="text-slate-400 text-xs mt-1">
                  {activeTab === 'deals'
                    ? 'Hit "Scan Now" to search for furniture deals across retailers'
                    : 'Save deals from the main feed to see them here'}
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {/* Watches tab */}
      {activeTab === 'watches' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">
              Set up watches to get notified when deals match your criteria.
            </p>
            <button
              onClick={() => setShowAddWatch(!showAddWatch)}
              className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
            >
              <PlusCircle size={14} />
              Add Watch
            </button>
          </div>

          {/* Add watch form */}
          {showAddWatch && (
            <div className="bg-amber-50/50 border border-amber-200 rounded-xl p-4 space-y-3">
              <h3 className="text-sm font-medium text-slate-700">New Watch Alert</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-slate-500 mb-1">Keywords</label>
                  <input
                    value={watchForm.keywords}
                    onChange={(e) => setWatchForm({ ...watchForm, keywords: e.target.value })}
                    placeholder="e.g. sectional sofa leather"
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-amber-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Category</label>
                  <select
                    value={watchForm.category}
                    onChange={(e) => setWatchForm({ ...watchForm, category: e.target.value })}
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Max Price ($)</label>
                  <input
                    type="number"
                    min={0}
                    value={watchForm.max_price || ''}
                    onChange={(e) => setWatchForm({ ...watchForm, max_price: +e.target.value })}
                    placeholder="0 = any"
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Min Discount %</label>
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={watchForm.min_discount || ''}
                    onChange={(e) => setWatchForm({ ...watchForm, min_discount: +e.target.value })}
                    placeholder="0 = any"
                    className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Notify</label>
                  <label className="flex items-center gap-2 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={watchForm.notify}
                      onChange={(e) => setWatchForm({ ...watchForm, notify: e.target.checked })}
                      className="rounded"
                    />
                    Send browser alert
                  </label>
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleAddWatch}
                  className="px-4 py-2 bg-amber-500 text-white text-sm rounded-lg hover:bg-amber-600"
                >
                  Save Watch
                </button>
                <button
                  onClick={() => setShowAddWatch(false)}
                  className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Watch list */}
          <div className="space-y-2">
            {watches.map((watch) => (
              <div
                key={watch.id}
                className={`bg-white rounded-xl border p-4 ${watch.active ? 'border-slate-200' : 'border-slate-100 opacity-60'}`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      {watch.notify && <Bell size={14} className="text-amber-500" />}
                      <h3 className="text-sm font-medium text-slate-900">
                        {watch.keywords || watch.category || 'All furniture'}
                      </h3>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                      {watch.category && (
                        <span className="flex items-center gap-1">
                          <Tag size={10} />
                          {watch.category}
                        </span>
                      )}
                      {watch.max_price > 0 && (
                        <span className="flex items-center gap-1">
                          <DollarSign size={10} />
                          Under ${watch.max_price}
                        </span>
                      )}
                      {watch.min_discount > 0 && (
                        <span>{watch.min_discount}%+ off</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => updateWatch(watch.id, { active: !watch.active })}
                      className={`p-1.5 rounded ${
                        watch.active
                          ? 'text-green-600 hover:bg-green-50'
                          : 'text-slate-400 hover:bg-slate-50'
                      }`}
                      title={watch.active ? 'Pause' : 'Resume'}
                    >
                      {watch.active ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                    <button
                      onClick={() => { if (confirm('Delete this watch?')) deleteWatch(watch.id) }}
                      className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {watches.length === 0 && (
              <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
                <Bell size={40} className="mx-auto text-slate-300 mb-3" />
                <p className="text-slate-500 text-sm">No watches set up yet</p>
                <p className="text-slate-400 text-xs mt-1">
                  Add a watch to get alerts when matching deals are found
                </p>
              </div>
            )}
          </div>

          {/* Cleanup button */}
          {deals.some((d) => d.is_dismissed) && (
            <button
              onClick={cleanupDeals}
              className="text-xs text-slate-400 hover:text-slate-600"
            >
              Clear dismissed deals
            </button>
          )}
        </div>
      )}

      {/* How it works */}
      <div className="bg-slate-50 rounded-xl border border-slate-200 p-5 space-y-3">
        <h2 className="text-sm font-semibold text-slate-700">How Deal Finder Works</h2>
        <div className="text-xs text-slate-500 space-y-2">
          <p><strong>1. Set up watches</strong> — Tell us what furniture you're looking for (keywords, category, price range, minimum discount).</p>
          <p><strong>2. Scan for deals</strong> — Hit "Scan Now" to search deal aggregators for matching furniture discounts from Wayfair, Home Depot, Target, Amazon, and more.</p>
          <p><strong>3. Get alerted</strong> — Enable browser notifications to get instant alerts when hot deals drop. Save the best ones for later.</p>
          <p><strong>4. Buy & track</strong> — When you purchase a deal, add it directly to your staging inventory.</p>
        </div>
        <p className="text-xs text-slate-400">
          Sources: Slickdeals, DealNews. Scans sale/clearance listings for home staging furniture.
        </p>
      </div>
    </div>
  )
}
