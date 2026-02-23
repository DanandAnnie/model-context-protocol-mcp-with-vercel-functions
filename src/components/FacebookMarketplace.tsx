import { useState } from 'react'
import {
  ExternalLink, Search, PlusCircle, TrendingDown, TrendingUp, Minus,
  MapPin, Star, Tag, ShoppingBag, Sparkles, X, ChevronDown, ChevronUp,
} from 'lucide-react'
import {
  analyzePrice, buildMarketplaceSearchUrl, getStagingSearchSuggestions,
  type PriceAnalysis, type DealRating,
} from '../lib/price-analyzer'
import type { DealWatch } from '../lib/database.types'

interface MarketplaceDeal {
  id: string
  title: string
  asking_price: number
  description: string
  condition: string
  fb_url: string
  image_url: string
  analysis: PriceAnalysis | null
  added_at: string
}

const CACHE_KEY = 'fb_marketplace_deals'

function loadCachedDeals(): MarketplaceDeal[] {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')
  } catch {
    return []
  }
}

function saveCachedDeals(deals: MarketplaceDeal[]) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(deals.slice(0, 100)))
}

const RATING_CONFIG: Record<DealRating, { bg: string; text: string; border: string; label: string; icon: typeof TrendingDown }> = {
  great: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', label: 'Great Deal', icon: TrendingDown },
  good: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', label: 'Good Price', icon: TrendingDown },
  fair: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', label: 'Fair Price', icon: Minus },
  overpriced: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', label: 'Overpriced', icon: TrendingUp },
}

interface Props {
  watches: DealWatch[]
}

export default function FacebookMarketplace({ watches }: Props) {
  const [fbDeals, setFbDeals] = useState<MarketplaceDeal[]>(loadCachedDeals)
  const [showAddForm, setShowAddForm] = useState(false)
  const [showSearches, setShowSearches] = useState(true)
  const [form, setForm] = useState({
    title: '',
    asking_price: '',
    description: '',
    condition: 'used',
    fb_url: '',
  })

  // Location settings
  const [city, setCity] = useState(() => localStorage.getItem('fb_marketplace_city') || '')
  const [radius, setRadius] = useState(() => parseInt(localStorage.getItem('fb_marketplace_radius') || '40', 10))
  const [maxPrice, setMaxPrice] = useState(() => parseInt(localStorage.getItem('fb_marketplace_max_price') || '500', 10))
  const [showSettings, setShowSettings] = useState(false)

  const saveSettings = () => {
    localStorage.setItem('fb_marketplace_city', city)
    localStorage.setItem('fb_marketplace_radius', String(radius))
    localStorage.setItem('fb_marketplace_max_price', String(maxPrice))
    setShowSettings(false)
  }

  // Build search links from watches + staging suggestions
  const suggestions = getStagingSearchSuggestions()

  const watchSearches = watches
    .filter((w) => w.active && w.keywords)
    .map((w) => ({
      label: w.keywords,
      url: buildMarketplaceSearchUrl(w.keywords, { city, maxPrice: w.max_price || maxPrice, radius }),
    }))

  const suggestionSearches = suggestions.map((s) => ({
    label: s.label,
    url: buildMarketplaceSearchUrl(s.keywords, { city, maxPrice, radius }),
  }))

  // Add a marketplace deal with AI analysis
  const handleAddDeal = () => {
    const price = parseFloat(form.asking_price)
    if (!form.title || isNaN(price) || price <= 0) return

    const analysis = analyzePrice(form.title, price, `${form.description} ${form.condition}`)

    const deal: MarketplaceDeal = {
      id: crypto.randomUUID(),
      title: form.title,
      asking_price: price,
      description: form.description,
      condition: form.condition,
      fb_url: form.fb_url,
      image_url: '',
      analysis,
      added_at: new Date().toISOString(),
    }

    const updated = [deal, ...fbDeals]
    setFbDeals(updated)
    saveCachedDeals(updated)
    setForm({ title: '', asking_price: '', description: '', condition: 'used', fb_url: '' })
    setShowAddForm(false)
  }

  const removeDeal = (id: string) => {
    const updated = fbDeals.filter((d) => d.id !== id)
    setFbDeals(updated)
    saveCachedDeals(updated)
  }

  return (
    <div className="space-y-4">
      {/* Location settings */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="flex items-center justify-between w-full text-sm"
        >
          <div className="flex items-center gap-2 text-slate-700 font-medium">
            <MapPin size={16} className="text-blue-500" />
            {city ? `Searching near ${city}` : 'Set your location for local results'}
            {radius > 0 && <span className="text-slate-400 font-normal">({radius} mi radius)</span>}
          </div>
          {showSettings ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
        </button>

        {showSettings && (
          <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-3 gap-3">
            <div className="col-span-3 sm:col-span-1">
              <label className="block text-xs text-slate-500 mb-1">City / Area</label>
              <input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. dallas, austin"
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Radius (miles)</label>
              <select
                value={radius}
                onChange={(e) => setRadius(+e.target.value)}
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
              >
                {[5, 10, 20, 40, 60, 100].map((r) => (
                  <option key={r} value={r}>{r} miles</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Max Price ($)</label>
              <input
                type="number"
                min={0}
                value={maxPrice || ''}
                onChange={(e) => setMaxPrice(+e.target.value)}
                placeholder="500"
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
              />
            </div>
            <div className="col-span-3 flex justify-end">
              <button
                onClick={saveSettings}
                className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
              >
                Save Settings
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Quick search links */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
        <button
          onClick={() => setShowSearches(!showSearches)}
          className="flex items-center justify-between w-full"
        >
          <h3 className="text-sm font-medium text-slate-700 flex items-center gap-2">
            <Search size={16} className="text-purple-500" />
            Quick Search Facebook Marketplace
          </h3>
          {showSearches ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
        </button>

        {showSearches && (
          <>
            {/* Searches from active watches */}
            {watchSearches.length > 0 && (
              <div>
                <p className="text-xs text-slate-400 mb-2 uppercase tracking-wide font-medium">From Your Watches</p>
                <div className="flex flex-wrap gap-2">
                  {watchSearches.map((s, i) => (
                    <button
                      key={`w-${i}`}
                      onClick={() => window.open(s.url, '_blank', 'noopener,noreferrer')}
                      className="flex items-center gap-1.5 px-4 py-2 bg-purple-50 text-purple-700 text-sm font-medium rounded-full border border-purple-200 hover:bg-purple-100 active:bg-purple-200 transition-colors min-h-[44px]"
                    >
                      <Search size={14} />
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Staging-specific suggestions */}
            <div>
              <p className="text-xs text-slate-400 mb-2 uppercase tracking-wide font-medium">Staging Essentials</p>
              <div className="flex flex-wrap gap-2">
                {suggestionSearches.map((s, i) => (
                  <button
                    key={`s-${i}`}
                    onClick={() => window.open(s.url, '_blank', 'noopener,noreferrer')}
                    className="flex items-center gap-1.5 px-4 py-2 bg-slate-50 text-slate-600 text-sm font-medium rounded-full border border-slate-200 hover:bg-slate-100 active:bg-slate-200 transition-colors min-h-[44px]"
                  >
                    <Search size={14} />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-xs text-slate-400 mt-1">
              Tap a search to open Facebook Marketplace. Found something? Add it below for price analysis.
            </p>
          </>
        )}
      </div>

      {/* Add deal for analysis */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Paste deals from Marketplace to get AI price analysis.
        </p>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-1.5 px-3 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700"
        >
          <PlusCircle size={14} />
          Analyze Deal
        </button>
      </div>

      {/* Add form */}
      {showAddForm && (
        <div className="bg-purple-50/50 border border-purple-200 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-medium text-slate-700 flex items-center gap-2">
            <Sparkles size={16} className="text-purple-500" />
            AI Price Analysis
          </h3>
          <p className="text-xs text-slate-500">
            Paste the listing title and asking price — the AI will compare against retail to tell you if it's a good deal.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1">Item Title (from listing)</label>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder='e.g. "West Elm Mid-Century Coffee Table"'
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-purple-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Asking Price ($)</label>
              <input
                type="number"
                min={0}
                step={1}
                value={form.asking_price}
                onChange={(e) => setForm({ ...form, asking_price: e.target.value })}
                placeholder="e.g. 120"
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Condition</label>
              <select
                value={form.condition}
                onChange={(e) => setForm({ ...form, condition: e.target.value })}
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
              >
                <option value="new">New / Sealed</option>
                <option value="like new">Like New</option>
                <option value="good">Good</option>
                <option value="fair">Fair</option>
                <option value="used">Used (general)</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1">Description / Notes (optional)</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Any details from the listing — brand, dimensions, color, damage, etc."
                rows={2}
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm resize-none"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1">Facebook Marketplace Link (optional)</label>
              <input
                value={form.fb_url}
                onChange={(e) => setForm({ ...form, fb_url: e.target.value })}
                placeholder="https://www.facebook.com/marketplace/item/..."
                className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={handleAddDeal}
              disabled={!form.title || !form.asking_price}
              className="px-4 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 disabled:opacity-40 flex items-center gap-2"
            >
              <Sparkles size={14} />
              Analyze Price
            </button>
            <button
              onClick={() => setShowAddForm(false)}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Analyzed deals list */}
      <div className="space-y-3">
        {fbDeals.map((deal) => {
          const ratingCfg = deal.analysis ? RATING_CONFIG[deal.analysis.rating] : null
          const RatingIcon = ratingCfg?.icon || Minus

          return (
            <div
              key={deal.id}
              className={`bg-white rounded-xl border p-4 ${ratingCfg ? ratingCfg.border : 'border-slate-200'}`}
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {ratingCfg && (
                      <span className={`flex items-center gap-1 px-2 py-0.5 ${ratingCfg.bg} ${ratingCfg.text} text-xs font-bold rounded`}>
                        <RatingIcon size={12} />
                        {ratingCfg.label}
                      </span>
                    )}
                    <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 text-xs font-medium rounded">
                      FB Marketplace
                    </span>
                    {deal.condition && (
                      <span className="text-xs text-slate-400 capitalize">{deal.condition}</span>
                    )}
                  </div>

                  <h3 className="text-sm font-medium text-slate-900">{deal.title}</h3>

                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-lg font-bold text-slate-800">${deal.asking_price.toLocaleString()}</span>
                    {deal.analysis && deal.analysis.retail_estimate_high > 0 && (
                      <span className="text-xs text-slate-400">
                        Retail: ${deal.analysis.retail_estimate_low}–${deal.analysis.retail_estimate_high}
                      </span>
                    )}
                    {deal.analysis && deal.analysis.savings_percent > 0 && (
                      <span className="text-xs font-semibold text-green-600">
                        {deal.analysis.savings_percent}% below retail
                      </span>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => removeDeal(deal.id)}
                  className="p-1 text-slate-300 hover:text-slate-500"
                  title="Remove"
                >
                  <X size={16} />
                </button>
              </div>

              {/* AI Analysis */}
              {deal.analysis && (
                <div className={`mt-3 rounded-lg p-3 ${ratingCfg?.bg || 'bg-slate-50'} text-xs`}>
                  <div className="flex items-start gap-2">
                    <Sparkles size={14} className={`flex-shrink-0 mt-0.5 ${ratingCfg?.text || 'text-slate-500'}`} />
                    <div className="space-y-1.5">
                      <p className={`${ratingCfg?.text || 'text-slate-600'} leading-relaxed`}>
                        {deal.analysis.reasoning}
                      </p>
                      <div className="flex items-center gap-3 text-slate-500">
                        <span className="flex items-center gap-1">
                          <Star size={10} />
                          Staging value: {deal.analysis.staging_value_score}/10
                        </span>
                        <span className="flex items-center gap-1">
                          <Tag size={10} />
                          Confidence: {deal.analysis.confidence}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {deal.description && (
                <p className="text-xs text-slate-500 mt-2 line-clamp-2">{deal.description}</p>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100">
                {deal.fb_url && (
                  <button
                    onClick={() => window.open(deal.fb_url, '_blank', 'noopener,noreferrer')}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 active:bg-blue-800 min-h-[44px]"
                  >
                    <ExternalLink size={12} />
                    View on Marketplace
                  </button>
                )}
                <span className="text-xs text-slate-400 ml-auto">
                  {new Date(deal.added_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          )
        })}

        {fbDeals.length === 0 && (
          <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
            <ShoppingBag size={40} className="mx-auto text-slate-300 mb-3" />
            <p className="text-slate-500 text-sm">No marketplace deals analyzed yet</p>
            <p className="text-slate-400 text-xs mt-1">
              Use the quick searches above to browse Facebook Marketplace, then paste listings here for AI price analysis
            </p>
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="bg-purple-50/30 rounded-xl border border-purple-100 p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Sparkles size={14} className="text-purple-500" />
          How Marketplace AI Analysis Works
        </h3>
        <div className="text-xs text-slate-500 space-y-2">
          <p><strong>1. Search</strong> — Tap any quick search link to browse FB Marketplace for staging furniture in your area.</p>
          <p><strong>2. Find a deal</strong> — When you spot something interesting, tap "Analyze Deal" and paste the listing details.</p>
          <p><strong>3. AI analysis</strong> — The AI compares the asking price against retail prices for that type of furniture, factoring in brand tier (IKEA vs Pottery Barn), condition, and staging usefulness.</p>
          <p><strong>4. Deal rating</strong> — Get a clear rating: <span className="text-green-700 font-medium">Great Deal</span>, <span className="text-blue-700 font-medium">Good Price</span>, <span className="text-amber-700 font-medium">Fair</span>, or <span className="text-red-700 font-medium">Overpriced</span> — plus a suggested offer price.</p>
        </div>
      </div>
    </div>
  )
}
