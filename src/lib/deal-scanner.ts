// Client-side deal scanner — runs directly in the browser
// Uses multiple CORS proxy strategies to fetch RSS feeds reliably

interface RawDeal {
  title: string
  description: string
  source: string
  source_url: string
  image_url: string
  original_price: number
  sale_price: number
  discount_percent: number
  category: string
  retailer: string
}

// Multiple CORS proxy strategies — try each until one works
const CORS_PROXIES = [
  (url: string) => `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`,
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
]

// Home staging furniture keywords
const STAGING_KEYWORDS = [
  'sofa', 'couch', 'dining table', 'bed frame', 'nightstand', 'dresser', 'coffee table',
  'end table', 'accent chair', 'area rug', 'throw pillow', 'lamp', 'mirror', 'artwork',
  'bookshelf', 'console table', 'bar stool', 'ottoman', 'desk', 'armchair',
  'duvet', 'comforter', 'curtain', 'vase', 'planter', 'candle', 'towel set',
  'dinnerware', 'flatware', 'kitchen', 'bathroom', 'bedroom', 'living room',
  'patio furniture', 'outdoor', 'staging', 'hayneedle', 'furniture',
]

function extractPrice(text: string): number {
  const match = text.match(/\$([0-9,]+(?:\.[0-9]{2})?)/)?.[1]
  return match ? parseFloat(match.replace(/,/g, '')) : 0
}

function categorizeItem(title: string): string {
  const t = title.toLowerCase()
  if (/sofa|couch|sectional|loveseat|ottoman|accent chair|armchair/i.test(t)) return 'living room'
  if (/bed|mattress|nightstand|dresser|headboard|comforter|duvet/i.test(t)) return 'bedroom'
  if (/dining|kitchen|flatware|dinnerware|cookware|bar stool/i.test(t)) return 'kitchen & dining'
  if (/desk|office|bookshelf|shelf/i.test(t)) return 'office'
  if (/bath|towel|shower/i.test(t)) return 'bathroom'
  if (/patio|outdoor|garden/i.test(t)) return 'outdoor'
  if (/rug|lamp|mirror|curtain|art|decor|vase|candle|pillow|throw/i.test(t)) return 'living room'
  return 'other'
}

function extractRetailer(text: string): string {
  const t = text.toLowerCase()
  if (t.includes('wayfair')) return 'Wayfair'
  if (t.includes('home depot')) return 'Home Depot'
  if (t.includes('amazon')) return 'Amazon'
  if (t.includes('target')) return 'Target'
  if (t.includes('overstock')) return 'Overstock'
  if (t.includes('hayneedle')) return 'Walmart / Hayneedle'
  if (t.includes('walmart')) return 'Walmart'
  if (t.includes('ikea')) return 'IKEA'
  if (t.includes('pottery barn')) return 'Pottery Barn'
  if (t.includes('west elm')) return 'West Elm'
  if (t.includes('cb2') || t.includes('crate')) return 'Crate & Barrel'
  if (t.includes('costco')) return 'Costco'
  if (t.includes('lowes') || t.includes("lowe's")) return "Lowe's"
  if (t.includes('bed bath')) return 'Bed Bath & Beyond'
  if (t.includes('macy')) return "Macy's"
  return 'Unknown'
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
}

// Parse RSS XML into items
function parseRSSXml(xml: string): { title: string; link: string; description: string; thumbnail: string }[] {
  const items: { title: string; link: string; description: string; thumbnail: string }[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || ''
    const link = block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/)?.[1] || ''
    const desc = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || ''
    const thumb = block.match(/<media:thumbnail[^>]*url="([^"]+)"/)?.[1]
      || block.match(/<enclosure[^>]*url="([^"]+)"/)?.[1]
      || ''
    items.push({ title: title.trim(), link: link.trim(), description: desc.trim(), thumbnail: thumb.trim() })
  }
  return items
}

interface FeedItem {
  title: string
  link: string
  description: string
  thumbnail: string
}

// Fetch with timeout helper
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { signal: controller.signal })
    return resp
  } finally {
    clearTimeout(timer)
  }
}

// Fetch RSS feed using multiple proxy strategies until one works
async function fetchRSS(rssUrl: string): Promise<FeedItem[]> {
  // Strategy 1: RSS2JSON (returns JSON directly)
  try {
    const resp = await fetchWithTimeout(CORS_PROXIES[0](rssUrl), 8000)
    if (resp.ok) {
      const data = await resp.json()
      if (data.status === 'ok' && Array.isArray(data.items)) {
        return data.items.map((item: Record<string, string | { link?: string }>) => ({
          title: (item.title as string) || '',
          link: (item.link as string) || '',
          description: (item.description as string) || '',
          thumbnail: (item.thumbnail as string) || (item.enclosure as { link?: string })?.link || '',
        }))
      }
    }
  } catch { /* try next */ }

  // Strategy 2 & 3: Raw CORS proxies (return raw XML, we parse it)
  for (let i = 1; i < CORS_PROXIES.length; i++) {
    try {
      const resp = await fetchWithTimeout(CORS_PROXIES[i](rssUrl), 8000)
      if (resp.ok) {
        const xml = await resp.text()
        if (xml.includes('<item>') || xml.includes('<entry>')) {
          return parseRSSXml(xml)
        }
      }
    } catch { /* try next */ }
  }

  return []
}

function processItem(item: FeedItem, sourceName: string): RawDeal {
  const fullText = `${item.title || ''} ${item.description || ''}`
  const salePrice = extractPrice(item.description || '') || extractPrice(item.title || '')
  const originalMatch = fullText.match(/(?:was|reg|regular|list|from|originally|compare at)\s*\$([0-9,]+(?:\.[0-9]{2})?)/i)
  const originalPrice = originalMatch ? parseFloat(originalMatch[1].replace(/,/g, '')) : 0

  return {
    title: stripHtml(item.title || ''),
    description: stripHtml(item.description || '').slice(0, 300),
    source: sourceName,
    source_url: item.link || '',
    image_url: item.thumbnail || '',
    original_price: originalPrice || (salePrice > 0 ? salePrice * 1.4 : 0),
    sale_price: salePrice,
    discount_percent: originalPrice > 0 && salePrice > 0
      ? Math.round(((originalPrice - salePrice) / originalPrice) * 100)
      : 0,
    category: categorizeItem(item.title || ''),
    retailer: extractRetailer(fullText),
  }
}

async function scanSlickdeals(searchTerms: string[]): Promise<RawDeal[]> {
  try {
    const terms = [...new Set(['furniture', 'home decor', 'hayneedle', ...searchTerms])]
    const results: RawDeal[] = []

    const feeds = await Promise.all(
      terms.slice(0, 3).map((term) =>
        fetchRSS(`https://slickdeals.net/newsearch.php?searcharea=deals&searchin=first&rss=1&q=${encodeURIComponent(term)}`),
      ),
    )

    for (const items of feeds) {
      for (const item of items.slice(0, 10)) {
        results.push(processItem(item, 'slickdeals'))
      }
    }
    return results
  } catch {
    return []
  }
}

async function scanDealNews(keywords: string[]): Promise<RawDeal[]> {
  try {
    const items = await fetchRSS('https://www.dealnews.com/c142/Home-Garden/?rss=1')
    const kw = keywords.length > 0 ? keywords : STAGING_KEYWORDS

    return items
      .filter((item) => {
        const text = `${item.title} ${item.description}`.toLowerCase()
        return kw.some((k) => text.includes(k.toLowerCase()))
      })
      .map((item) => processItem(item, 'dealnews'))
  } catch {
    return []
  }
}

async function scanBradsDeals(keywords: string[]): Promise<RawDeal[]> {
  try {
    const items = await fetchRSS('https://www.bradsdeals.com/rss/home')
    const kw = keywords.length > 0 ? keywords : STAGING_KEYWORDS

    return items
      .filter((item) => {
        const text = `${item.title} ${item.description}`.toLowerCase()
        return kw.some((k) => text.includes(k.toLowerCase()))
      })
      .map((item) => processItem(item, 'bradsdeals'))
  } catch {
    return []
  }
}

export interface WatchCriteria {
  keywords: string
  category: string
  max_price: number
  min_discount: number
}

function matchesWatch(deal: RawDeal, watch: WatchCriteria): boolean {
  const text = `${deal.title} ${deal.description} ${deal.category}`.toLowerCase()
  const keywords = watch.keywords.toLowerCase().split(/\s+/).filter(Boolean)

  if (keywords.length > 0 && !keywords.some((kw) => text.includes(kw))) return false
  if (watch.category && !text.includes(watch.category.toLowerCase())) return false
  if (watch.max_price > 0 && deal.sale_price > watch.max_price) return false
  if (watch.min_discount > 0 && deal.discount_percent < watch.min_discount) return false

  return true
}

const EMPTY_RESULT = { deals: [] as RawDeal[], scanned_at: new Date().toISOString(), sources_checked: [] as string[] }

export async function scanDealsClientSide(
  watches?: WatchCriteria[],
): Promise<{ deals: RawDeal[]; scanned_at: string; sources_checked: string[] }> {
  try {
    // Collect keywords from watches
    const allKeywords = new Set<string>()
    for (const w of watches || []) {
      for (const kw of w.keywords.split(/\s+/).filter(Boolean)) {
        allKeywords.add(kw.toLowerCase())
      }
    }
    const keywordList = [...allKeywords]

    // Scan all sources in parallel — each source catches its own errors
    const [slickdeals, dealnews, bradsdeals] = await Promise.all([
      scanSlickdeals(keywordList),
      scanDealNews(keywordList),
      scanBradsDeals(keywordList),
    ])

    let allDeals = [...slickdeals, ...dealnews, ...bradsdeals]

    // Deduplicate by URL
    const seen = new Set<string>()
    allDeals = allDeals.filter((d) => {
      if (!d.source_url || seen.has(d.source_url)) return false
      seen.add(d.source_url)
      return true
    })

    // Filter by watches if provided
    if (watches && watches.length > 0) {
      allDeals = allDeals.filter((deal) =>
        watches.some((watch) => matchesWatch(deal, watch)),
      )
    }

    // Sort by discount descending
    allDeals.sort((a, b) => b.discount_percent - a.discount_percent)

    return {
      deals: allDeals.slice(0, 50),
      scanned_at: new Date().toISOString(),
      sources_checked: ['slickdeals', 'dealnews', 'bradsdeals'],
    }
  } catch {
    // Absolute last resort — never let this function throw
    return { ...EMPTY_RESULT, scanned_at: new Date().toISOString() }
  }
}
