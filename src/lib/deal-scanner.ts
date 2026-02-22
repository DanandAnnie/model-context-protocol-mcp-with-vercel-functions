// Client-side deal scanner — runs directly in the browser
// Uses RSS2JSON API to bypass CORS restrictions on RSS feeds

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

// RSS2JSON converts RSS feeds to JSON with CORS headers
const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url='

interface Rss2JsonItem {
  title: string
  link: string
  description: string
  content: string
  thumbnail: string
  enclosure?: { link?: string }
}

interface Rss2JsonResponse {
  status: string
  items: Rss2JsonItem[]
}

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

async function fetchRSS(rssUrl: string): Promise<Rss2JsonItem[]> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    const resp = await fetch(`${RSS2JSON}${encodeURIComponent(rssUrl)}`, {
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!resp.ok) return []
    const data: Rss2JsonResponse = await resp.json()
    if (data.status !== 'ok') return []
    return data.items || []
  } catch {
    return []
  }
}

function processItem(item: Rss2JsonItem, sourceName: string): RawDeal {
  const fullText = `${item.title} ${item.description} ${item.content || ''}`
  const salePrice = extractPrice(item.description) || extractPrice(item.title)
  const originalMatch = fullText.match(/(?:was|reg|regular|list|from|originally|compare at)\s*\$([0-9,]+(?:\.[0-9]{2})?)/i)
  const originalPrice = originalMatch ? parseFloat(originalMatch[1].replace(/,/g, '')) : 0

  return {
    title: stripHtml(item.title),
    description: stripHtml(item.description).slice(0, 300),
    source: sourceName,
    source_url: item.link,
    image_url: item.thumbnail || item.enclosure?.link || '',
    original_price: originalPrice || (salePrice > 0 ? salePrice * 1.4 : 0),
    sale_price: salePrice,
    discount_percent: originalPrice > 0 && salePrice > 0
      ? Math.round(((originalPrice - salePrice) / originalPrice) * 100)
      : 0,
    category: categorizeItem(item.title),
    retailer: extractRetailer(fullText),
  }
}

async function scanSlickdeals(searchTerms: string[]): Promise<RawDeal[]> {
  const terms = [...new Set(['furniture', 'home decor', 'hayneedle', ...searchTerms])]
  const results: RawDeal[] = []

  // Fetch top 3 search terms in parallel
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
}

async function scanDealNews(keywords: string[]): Promise<RawDeal[]> {
  const items = await fetchRSS('https://www.dealnews.com/c142/Home-Garden/?rss=1')
  const kw = keywords.length > 0 ? keywords : STAGING_KEYWORDS

  return items
    .filter((item) => {
      const text = `${item.title} ${item.description}`.toLowerCase()
      return kw.some((k) => text.includes(k.toLowerCase()))
    })
    .map((item) => processItem(item, 'dealnews'))
}

async function scanBradsDeals(keywords: string[]): Promise<RawDeal[]> {
  const items = await fetchRSS('https://www.bradsdeals.com/rss/home')
  const kw = keywords.length > 0 ? keywords : STAGING_KEYWORDS

  return items
    .filter((item) => {
      const text = `${item.title} ${item.description}`.toLowerCase()
      return kw.some((k) => text.includes(k.toLowerCase()))
    })
    .map((item) => processItem(item, 'bradsdeals'))
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

export async function scanDealsClientSide(
  watches?: WatchCriteria[],
): Promise<{ deals: RawDeal[]; scanned_at: string; sources_checked: string[] }> {
  // Collect keywords from watches
  const allKeywords = new Set<string>()
  for (const w of watches || []) {
    for (const kw of w.keywords.split(/\s+/).filter(Boolean)) {
      allKeywords.add(kw.toLowerCase())
    }
  }
  const keywordList = [...allKeywords]

  // Scan all sources in parallel
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
}
