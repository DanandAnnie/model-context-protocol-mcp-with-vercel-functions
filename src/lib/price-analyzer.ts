// AI-powered price analysis for staging furniture
// Compares asking prices against known retail ranges to score deals

export type DealRating = 'great' | 'good' | 'fair' | 'overpriced'

export interface PriceAnalysis {
  rating: DealRating
  retail_estimate_low: number
  retail_estimate_high: number
  savings_percent: number
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
  staging_value_score: number // 1-10, how useful for staging
}

// Retail price database for common staging furniture (new prices in USD)
// Ranges represent budget-to-mid tier, which is what stagers typically buy
const RETAIL_PRICE_DB: Record<string, { low: number; high: number; staging: number }> = {
  // Living room seating
  'sofa': { low: 400, high: 1200, staging: 8 },
  'sectional': { low: 700, high: 2000, staging: 9 },
  'couch': { low: 400, high: 1200, staging: 8 },
  'loveseat': { low: 300, high: 800, staging: 7 },
  'accent chair': { low: 150, high: 500, staging: 8 },
  'armchair': { low: 200, high: 600, staging: 7 },
  'recliner': { low: 250, high: 800, staging: 5 },
  'ottoman': { low: 80, high: 300, staging: 6 },
  'futon': { low: 150, high: 400, staging: 4 },

  // Living room tables
  'coffee table': { low: 100, high: 400, staging: 9 },
  'end table': { low: 60, high: 200, staging: 8 },
  'side table': { low: 60, high: 200, staging: 8 },
  'console table': { low: 100, high: 400, staging: 8 },
  'tv stand': { low: 100, high: 350, staging: 6 },
  'media console': { low: 150, high: 500, staging: 6 },

  // Dining
  'dining table': { low: 200, high: 800, staging: 9 },
  'dining chair': { low: 60, high: 200, staging: 8 },
  'dining set': { low: 400, high: 1200, staging: 9 },
  'bar stool': { low: 50, high: 200, staging: 7 },
  'counter stool': { low: 60, high: 200, staging: 7 },
  'buffet': { low: 200, high: 700, staging: 6 },
  'sideboard': { low: 200, high: 700, staging: 6 },
  'china cabinet': { low: 200, high: 600, staging: 4 },

  // Bedroom
  'bed frame': { low: 150, high: 600, staging: 9 },
  'headboard': { low: 100, high: 400, staging: 8 },
  'nightstand': { low: 60, high: 250, staging: 9 },
  'dresser': { low: 200, high: 700, staging: 8 },
  'chest of drawers': { low: 150, high: 500, staging: 7 },
  'wardrobe': { low: 200, high: 600, staging: 5 },
  'vanity': { low: 100, high: 400, staging: 6 },
  'mattress': { low: 200, high: 800, staging: 3 },

  // Office
  'desk': { low: 100, high: 400, staging: 7 },
  'office chair': { low: 80, high: 350, staging: 5 },
  'bookshelf': { low: 80, high: 300, staging: 8 },
  'bookcase': { low: 80, high: 300, staging: 8 },
  'filing cabinet': { low: 60, high: 200, staging: 3 },

  // Decor & accessories
  'area rug': { low: 50, high: 300, staging: 9 },
  'rug': { low: 50, high: 300, staging: 9 },
  'lamp': { low: 25, high: 120, staging: 8 },
  'floor lamp': { low: 40, high: 150, staging: 8 },
  'table lamp': { low: 25, high: 100, staging: 8 },
  'mirror': { low: 30, high: 200, staging: 8 },
  'wall art': { low: 20, high: 150, staging: 9 },
  'artwork': { low: 20, high: 150, staging: 9 },
  'painting': { low: 20, high: 150, staging: 8 },
  'throw pillow': { low: 10, high: 40, staging: 7 },
  'pillow': { low: 10, high: 40, staging: 7 },
  'throw blanket': { low: 15, high: 60, staging: 7 },
  'curtain': { low: 20, high: 80, staging: 7 },
  'curtains': { low: 20, high: 80, staging: 7 },
  'drapes': { low: 30, high: 120, staging: 7 },
  'vase': { low: 10, high: 60, staging: 7 },
  'candle': { low: 5, high: 30, staging: 5 },
  'planter': { low: 10, high: 50, staging: 6 },
  'plant': { low: 10, high: 60, staging: 7 },

  // Bathroom
  'towel set': { low: 20, high: 60, staging: 6 },
  'bath mat': { low: 15, high: 40, staging: 5 },
  'shower curtain': { low: 15, high: 40, staging: 5 },
  'bathroom mirror': { low: 40, high: 200, staging: 6 },

  // Bedding
  'comforter': { low: 40, high: 150, staging: 7 },
  'duvet': { low: 50, high: 180, staging: 7 },
  'duvet cover': { low: 30, high: 100, staging: 7 },
  'sheet set': { low: 25, high: 80, staging: 6 },
  'bedding set': { low: 50, high: 200, staging: 7 },

  // Outdoor
  'patio set': { low: 300, high: 1200, staging: 7 },
  'patio chair': { low: 60, high: 250, staging: 6 },
  'patio table': { low: 100, high: 400, staging: 6 },
  'outdoor rug': { low: 30, high: 150, staging: 6 },
  'fire pit': { low: 80, high: 300, staging: 5 },
  'umbrella': { low: 30, high: 150, staging: 5 },

  // Kitchen
  'dinnerware': { low: 30, high: 100, staging: 5 },
  'flatware': { low: 20, high: 60, staging: 4 },
  'cookware': { low: 40, high: 200, staging: 3 },
  'kitchen island': { low: 150, high: 500, staging: 6 },

  // Storage / organization
  'shelf': { low: 40, high: 200, staging: 6 },
  'storage bench': { low: 80, high: 250, staging: 6 },
  'basket': { low: 10, high: 40, staging: 5 },
}

// Condition multipliers for used items
const CONDITION_MULTIPLIERS: Record<string, number> = {
  'new': 0.85,        // New in box on marketplace = ~85% of retail is fair
  'like new': 0.70,   // Like new = ~70% of retail
  'good': 0.50,       // Good condition = ~50% of retail
  'fair': 0.35,       // Fair condition = ~35% of retail
  'used': 0.45,       // Generic "used" = ~45% of retail
}

function findBestMatch(title: string): { key: string; data: { low: number; high: number; staging: number } } | null {
  const lower = title.toLowerCase()

  // Try exact multi-word matches first (longer phrases are more specific)
  const sortedKeys = Object.keys(RETAIL_PRICE_DB).sort((a, b) => b.length - a.length)
  for (const key of sortedKeys) {
    if (lower.includes(key)) {
      return { key, data: RETAIL_PRICE_DB[key] }
    }
  }

  return null
}

function detectCondition(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes('brand new') || lower.includes('new in box') || lower.includes('nib') || lower.includes('bnib')) return 'new'
  if (lower.includes('like new') || lower.includes('excellent') || lower.includes('mint') || lower.includes('barely used')) return 'like new'
  if (lower.includes('good condition') || lower.includes('great condition') || lower.includes('gently used')) return 'good'
  if (lower.includes('fair') || lower.includes('some wear') || lower.includes('well loved') || lower.includes('needs')) return 'fair'
  if (lower.includes('used')) return 'used'
  return 'used' // default assumption for marketplace items
}

function detectBrand(text: string): { tier: 'luxury' | 'premium' | 'mid' | 'budget'; multiplier: number } {
  const lower = text.toLowerCase()

  // Luxury brands — retail is much higher
  const luxury = ['restoration hardware', 'rh ', 'pottery barn', 'west elm', 'crate and barrel', 'cb2',
    'arhaus', 'ethan allen', 'room and board', 'herman miller', 'knoll']
  if (luxury.some((b) => lower.includes(b))) return { tier: 'luxury', multiplier: 2.5 }

  // Premium brands
  const premium = ['article', 'joybird', 'burrow', 'floyd', 'interior define',
    'ashley furniture', 'la-z-boy', 'lazboy', 'thomasville', 'broyhill']
  if (premium.some((b) => lower.includes(b))) return { tier: 'premium', multiplier: 1.6 }

  // Budget brands
  const budget = ['ikea', 'target', 'walmart', 'mainstays', 'better homes',
    'threshold', 'room essentials']
  if (budget.some((b) => lower.includes(b))) return { tier: 'budget', multiplier: 0.7 }

  return { tier: 'mid', multiplier: 1.0 }
}

export function analyzePrice(
  title: string,
  askingPrice: number,
  description: string = '',
): PriceAnalysis {
  const fullText = `${title} ${description}`
  const match = findBestMatch(fullText)

  if (!match || askingPrice <= 0) {
    return {
      rating: 'fair',
      retail_estimate_low: 0,
      retail_estimate_high: 0,
      savings_percent: 0,
      confidence: 'low',
      reasoning: askingPrice <= 0
        ? 'No asking price provided — check the listing for pricing.'
        : 'Could not identify the item type. Compare against similar new items online to determine value.',
      staging_value_score: 5,
    }
  }

  const condition = detectCondition(fullText)
  const brand = detectBrand(fullText)
  const conditionMultiplier = CONDITION_MULTIPLIERS[condition] || 0.45

  // Adjust retail range based on brand tier
  const retailLow = Math.round(match.data.low * brand.multiplier)
  const retailHigh = Math.round(match.data.high * brand.multiplier)
  const retailMid = (retailLow + retailHigh) / 2

  // Fair market value for this condition
  const fairValueLow = Math.round(retailLow * conditionMultiplier)
  const fairValueHigh = Math.round(retailHigh * conditionMultiplier)
  const fairValueMid = (fairValueLow + fairValueHigh) / 2

  // How much cheaper than retail mid-point
  const savingsVsRetail = retailMid > 0
    ? Math.round(((retailMid - askingPrice) / retailMid) * 100)
    : 0

  // Rating based on where the asking price falls vs fair market value
  let rating: DealRating
  let reasoning: string

  if (askingPrice <= fairValueLow * 0.8) {
    rating = 'great'
    reasoning = `Priced well below fair market value for a ${condition} ${match.key}. `
      + `Retail is $${retailLow}–$${retailHigh} new. `
      + `At ${condition} condition, fair market is $${fairValueLow}–$${fairValueHigh}. `
      + `This is a steal${brand.tier === 'luxury' ? ` — especially for ${brand.tier} tier` : ''}.`
  } else if (askingPrice <= fairValueMid) {
    rating = 'good'
    reasoning = `Good price for a ${condition} ${match.key}. `
      + `Retail is $${retailLow}–$${retailHigh} new. `
      + `Fair market for ${condition} condition is $${fairValueLow}–$${fairValueHigh}. `
      + `Worth considering for staging.`
  } else if (askingPrice <= fairValueHigh * 1.1) {
    rating = 'fair'
    reasoning = `Asking price is in the expected range for a ${condition} ${match.key}. `
      + `Retail is $${retailLow}–$${retailHigh} new. `
      + `You might negotiate down a bit — try offering $${Math.round(fairValueMid)}.`
  } else {
    rating = 'overpriced'
    reasoning = `Overpriced for a ${condition} ${match.key}. `
      + `Retail is $${retailLow}–$${retailHigh} new. `
      + `For ${condition} condition, fair price is closer to $${fairValueLow}–$${fairValueHigh}. `
      + `Offer $${Math.round(fairValueMid)} or less, or skip it.`
  }

  return {
    rating,
    retail_estimate_low: retailLow,
    retail_estimate_high: retailHigh,
    savings_percent: Math.max(0, savingsVsRetail),
    confidence: brand.tier !== 'mid' || condition !== 'used' ? 'high' : 'medium',
    reasoning,
    staging_value_score: match.data.staging,
  }
}

// Generate Facebook Marketplace search URLs
export function buildMarketplaceSearchUrl(
  keywords: string,
  options?: {
    minPrice?: number
    maxPrice?: number
    city?: string
    radius?: number // miles
  },
): string {
  // Facebook Marketplace uses these query params: query, minPrice, maxPrice, sortBy, daysSinceListed, exact
  // "radius" is NOT a valid param — Facebook uses the user's own location
  // City slug in the path (e.g. /marketplace/dallas/search) works for some cities but is unreliable
  const params = new URLSearchParams()
  params.set('query', keywords)
  params.set('sortBy', 'creation_time_descend')
  params.set('daysSinceListed', '7')
  params.set('exact', 'false')
  if (options?.minPrice) params.set('minPrice', String(options.minPrice))
  if (options?.maxPrice) params.set('maxPrice', String(options.maxPrice))

  // Use city slug if provided (lowercase, no spaces) — falls back to user's FB location
  const citySlug = options?.city?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || ''
  const base = citySlug
    ? `https://www.facebook.com/marketplace/${citySlug}/search`
    : 'https://www.facebook.com/marketplace/search'

  return `${base}/?${params.toString()}`
}

// Generate smart search suggestions for staging items
export function getStagingSearchSuggestions(): { label: string; keywords: string; category: string }[] {
  return [
    { label: 'Sofas & Sectionals', keywords: 'sofa sectional couch', category: 'living room' },
    { label: 'Coffee & Side Tables', keywords: 'coffee table end table side table', category: 'living room' },
    { label: 'Dining Sets', keywords: 'dining table chairs set', category: 'kitchen & dining' },
    { label: 'Bed Frames & Headboards', keywords: 'bed frame headboard queen king', category: 'bedroom' },
    { label: 'Nightstands & Dressers', keywords: 'nightstand dresser bedroom', category: 'bedroom' },
    { label: 'Area Rugs', keywords: 'area rug 8x10 5x7', category: 'living room' },
    { label: 'Lamps & Lighting', keywords: 'floor lamp table lamp modern', category: 'living room' },
    { label: 'Wall Art & Mirrors', keywords: 'wall art mirror large framed', category: 'living room' },
    { label: 'Accent Chairs', keywords: 'accent chair armchair modern', category: 'living room' },
    { label: 'Bar Stools', keywords: 'bar stool counter stool', category: 'kitchen & dining' },
    { label: 'Bookshelves', keywords: 'bookshelf bookcase shelf', category: 'office' },
    { label: 'Outdoor / Patio', keywords: 'patio furniture outdoor set', category: 'outdoor' },
  ]
}
