import type { VercelRequest, VercelResponse } from '@vercel/node'

// Furniture deal scanning API endpoint
// Fetches deals from multiple sources and returns matching results

interface DealResult {
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

interface WatchCriteria {
  keywords: string
  category: string
  max_price: number
  min_discount: number
  sources: string[]
}

// Parse RSS/Atom XML feed for deal items
function parseRSSItems(xml: string): { title: string; link: string; description: string }[] {
  const items: { title: string; link: string; description: string }[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi
  let match

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const title = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || ''
    const link = block.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1] || ''
    const desc = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || ''
    items.push({ title: title.trim(), link: link.trim(), description: desc.trim() })
  }

  return items
}

// Extract price from text
function extractPrice(text: string): number {
  const match = text.match(/\$([0-9,]+(?:\.[0-9]{2})?)/)?.[1]
  return match ? parseFloat(match.replace(/,/g, '')) : 0
}

// Score a deal against watch criteria
function matchesWatch(deal: DealResult, watch: WatchCriteria): boolean {
  const text = `${deal.title} ${deal.description} ${deal.category}`.toLowerCase()
  const keywords = watch.keywords.toLowerCase().split(/\s+/).filter(Boolean)

  // Check keywords
  if (keywords.length > 0 && !keywords.some((kw) => text.includes(kw))) return false

  // Check category
  if (watch.category && !text.includes(watch.category.toLowerCase())) return false

  // Check max price
  if (watch.max_price > 0 && deal.sale_price > watch.max_price) return false

  // Check min discount
  if (watch.min_discount > 0 && deal.discount_percent < watch.min_discount) return false

  return true
}

// Home staging furniture categories to search for
const STAGING_KEYWORDS = [
  'sofa', 'couch', 'dining table', 'bed frame', 'nightstand', 'dresser', 'coffee table',
  'end table', 'accent chair', 'area rug', 'throw pillow', 'lamp', 'mirror', 'artwork',
  'bookshelf', 'console table', 'bar stool', 'ottoman', 'desk', 'armchair',
  'duvet', 'comforter', 'curtain', 'vase', 'planter', 'candle', 'towel set',
  'dinnerware', 'flatware', 'kitchen', 'bathroom', 'bedroom', 'living room',
  'patio furniture', 'outdoor', 'staging', 'hayneedle',
]

// Deal source scanners
async function scanSlickdeals(keywords: string[]): Promise<DealResult[]> {
  const results: DealResult[] = []

  try {
    // Always include hayneedle + furniture as base search terms
    const baseTerms = ['furniture', 'home decor', 'hayneedle']
    const userTerms = keywords.length > 0 ? keywords : []
    const searchTerms = [...new Set([...userTerms, ...baseTerms])]
    for (const term of searchTerms.slice(0, 5)) {
      const url = `https://slickdeals.net/newsearch.php?searcharea=deals&searchin=first&rss=1&q=${encodeURIComponent(term)}`
      const resp = await fetch(url, { headers: { 'User-Agent': 'StagingInventoryManager/1.0' } })
      if (!resp.ok) continue
      const xml = await resp.text()
      const items = parseRSSItems(xml)

      for (const item of items.slice(0, 10)) {
        const salePrice = extractPrice(item.description) || extractPrice(item.title)
        const originalMatch = item.description.match(/(?:was|reg|regular|list|from)\s*\$([0-9,]+(?:\.[0-9]{2})?)/i)
        const originalPrice = originalMatch ? parseFloat(originalMatch[1].replace(/,/g, '')) : salePrice * 1.5

        results.push({
          title: item.title.replace(/<[^>]+>/g, ''),
          description: item.description.replace(/<[^>]+>/g, '').slice(0, 300),
          source: 'slickdeals',
          source_url: item.link,
          image_url: '',
          original_price: originalPrice,
          sale_price: salePrice,
          discount_percent: originalPrice > 0 ? Math.round(((originalPrice - salePrice) / originalPrice) * 100) : 0,
          category: categorizeItem(item.title),
          retailer: extractRetailer(item.title + ' ' + item.description),
        })
      }
    }
  } catch { /* network error, skip */ }

  return results
}

async function scanDealNews(keywords: string[]): Promise<DealResult[]> {
  const results: DealResult[] = []

  try {
    // DealNews home/garden category RSS
    const url = 'https://www.dealnews.com/c142/Home-Garden/?rss=1'
    const resp = await fetch(url, { headers: { 'User-Agent': 'StagingInventoryManager/1.0' } })
    if (!resp.ok) return results
    const xml = await resp.text()
    const items = parseRSSItems(xml)

    const kw = keywords.length > 0 ? keywords : STAGING_KEYWORDS

    for (const item of items) {
      const text = `${item.title} ${item.description}`.toLowerCase()
      if (!kw.some((k) => text.includes(k.toLowerCase()))) continue

      const salePrice = extractPrice(item.description) || extractPrice(item.title)
      const originalMatch = item.description.match(/(?:was|list|reg)\s*\$([0-9,]+(?:\.[0-9]{2})?)/i)
      const originalPrice = originalMatch ? parseFloat(originalMatch[1].replace(/,/g, '')) : 0

      results.push({
        title: item.title.replace(/<[^>]+>/g, ''),
        description: item.description.replace(/<[^>]+>/g, '').slice(0, 300),
        source: 'other',
        source_url: item.link,
        image_url: '',
        original_price: originalPrice || salePrice * 1.3,
        sale_price: salePrice,
        discount_percent: originalPrice > 0 ? Math.round(((originalPrice - salePrice) / originalPrice) * 100) : 0,
        category: categorizeItem(item.title),
        retailer: extractRetailer(item.title + ' ' + item.description),
      })
    }
  } catch { /* network error, skip */ }

  return results
}

async function scanBradsDeals(keywords: string[]): Promise<DealResult[]> {
  const results: DealResult[] = []

  try {
    // Brad's Deals home category RSS
    const url = 'https://www.bradsdeals.com/rss/home'
    const resp = await fetch(url, { headers: { 'User-Agent': 'StagingInventoryManager/1.0' } })
    if (!resp.ok) return results
    const xml = await resp.text()
    const items = parseRSSItems(xml)

    const kw = keywords.length > 0 ? keywords : STAGING_KEYWORDS

    for (const item of items) {
      const text = `${item.title} ${item.description}`.toLowerCase()
      if (!kw.some((k) => text.includes(k.toLowerCase()))) continue

      const salePrice = extractPrice(item.description) || extractPrice(item.title)
      const originalMatch = item.description.match(/(?:was|list|reg|originally|compare at)\s*\$([0-9,]+(?:\.[0-9]{2})?)/i)
      const originalPrice = originalMatch ? parseFloat(originalMatch[1].replace(/,/g, '')) : 0

      results.push({
        title: item.title.replace(/<[^>]+>/g, ''),
        description: item.description.replace(/<[^>]+>/g, '').slice(0, 300),
        source: 'other',
        source_url: item.link,
        image_url: '',
        original_price: originalPrice || salePrice * 1.3,
        sale_price: salePrice,
        discount_percent: originalPrice > 0 ? Math.round(((originalPrice - salePrice) / originalPrice) * 100) : 0,
        category: categorizeItem(item.title),
        retailer: extractRetailer(item.title + ' ' + item.description),
      })
    }
  } catch { /* network error, skip */ }

  return results
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { watches } = req.body as { watches: WatchCriteria[] }

    // Collect keywords from all watches
    const allKeywords = new Set<string>()
    for (const w of (watches || [])) {
      for (const kw of w.keywords.split(/\s+/).filter(Boolean)) {
        allKeywords.add(kw.toLowerCase())
      }
    }
    const keywordList = allKeywords.size > 0 ? [...allKeywords] : ['furniture', 'home decor', 'staging']

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
      if (seen.has(d.source_url)) return false
      seen.add(d.source_url)
      return true
    })

    // If watches provided, score and filter
    if (watches && watches.length > 0) {
      allDeals = allDeals.filter((deal) =>
        watches.some((watch) => matchesWatch(deal, watch)),
      )
    }

    // Sort by discount descending
    allDeals.sort((a, b) => b.discount_percent - a.discount_percent)

    return res.status(200).json({
      deals: allDeals.slice(0, 50),
      scanned_at: new Date().toISOString(),
      sources_checked: ['slickdeals', 'dealnews', 'bradsdeals'],
    })
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to scan deal sources',
      details: err instanceof Error ? err.message : 'Unknown error',
    })
  }
}
