const STORAGE_KEY = 'staging-inv-anthropic-key'

export function getAnthropicKey(): string {
  // Check localStorage first, then fall back to env var from .env file
  return localStorage.getItem(STORAGE_KEY) || import.meta.env.VITE_ANTHROPIC_API_KEY || ''
}

export function saveAnthropicKey(key: string) {
  if (key) {
    localStorage.setItem(STORAGE_KEY, key)
  } else {
    localStorage.removeItem(STORAGE_KEY)
  }
}

export function isAIConfigured(): boolean {
  return getAnthropicKey().length > 0
}

export interface AIDimensions {
  length_inches: number
  width_inches: number
  height_inches: number
  confidence: 'high' | 'medium' | 'low'
  notes: string
}

export interface AIRoomDimensions {
  name: string
  length_ft: number
  width_ft: number
  confidence: 'high' | 'medium' | 'low'
  notes: string
}

/**
 * Send a furniture photo to Claude Vision to estimate dimensions.
 */
export async function measureItemFromImage(imageBase64: string, itemName?: string): Promise<AIDimensions> {
  const apiKey = getAnthropicKey()
  if (!apiKey) {
    throw new Error('Anthropic API key not configured. Go to Settings to add your key.')
  }

  const match = imageBase64.match(/^data:(image\/\w+);base64,(.+)/)
  if (!match) throw new Error('Invalid image format')

  const mediaType = match[1]
  const base64Data = match[2]

  const itemContext = itemName ? `The item is: "${itemName}".` : ''

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data },
            },
            {
              type: 'text',
              text: `You are an expert furniture dimensions estimator. ${itemContext}

Analyze this image and estimate the dimensions of the main furniture item in inches.

Use visual cues to estimate size:
- Standard door height is 80 inches (6'8")
- Standard ceiling is 96 inches (8')
- Standard couch seat height is 17-19 inches
- Standard dining table height is 28-30 inches
- Standard bed sizes: Twin 38x75, Full 54x75, Queen 60x80, King 76x80
- Standard doorknob height is ~36 inches
- Floor tiles are usually 12x12 or 18x18 inches
- If you see a person, average adult height is ~66 inches

Provide your best estimate. Return ONLY valid JSON with this exact structure:
{"length_inches":0,"width_inches":0,"height_inches":0,"confidence":"medium","notes":"Brief explanation of how you estimated"}

- length_inches: The longest horizontal dimension (front to back or side to side)
- width_inches: The shorter horizontal dimension
- height_inches: The vertical dimension (floor to top)
- confidence: "high" if clear reference objects visible, "medium" if reasonable estimate, "low" if very uncertain
- notes: Brief note about what reference cues you used

Round to the nearest whole inch. Do NOT return 0 for any dimension.`,
            },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    if (response.status === 401) throw new Error('Invalid Anthropic API key.')
    throw new Error(`AI request failed: ${err}`)
  }

  const data = await response.json()
  const text = data.content?.[0]?.text || '{}'

  let jsonStr = text.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  try {
    const result = JSON.parse(jsonStr)
    return {
      length_inches: Math.max(1, Math.round(Number(result.length_inches) || 0)),
      width_inches: Math.max(1, Math.round(Number(result.width_inches) || 0)),
      height_inches: Math.max(1, Math.round(Number(result.height_inches) || 0)),
      confidence: ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'low',
      notes: typeof result.notes === 'string' ? result.notes : '',
    }
  } catch {
    throw new Error('Failed to parse AI dimension estimate. Please try again.')
  }
}

/**
 * Send a room photo to Claude Vision to estimate room dimensions.
 */
export async function measureRoomFromImage(imageBase64: string): Promise<AIRoomDimensions> {
  const apiKey = getAnthropicKey()
  if (!apiKey) {
    throw new Error('Anthropic API key not configured. Go to Settings to add your key.')
  }

  const match = imageBase64.match(/^data:(image\/\w+);base64,(.+)/)
  if (!match) throw new Error('Invalid image format')

  const mediaType = match[1]
  const base64Data = match[2]

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data },
            },
            {
              type: 'text',
              text: `You are an expert room measurement estimator for home staging. Analyze this photo and estimate the room dimensions in feet.

Use visual cues to estimate the room size:
- Standard interior door is 32-36 inches wide and 80 inches tall (6'8")
- Standard ceiling height is 8 feet (96 inches)
- Standard window width is 24-36 inches
- Standard baseboard height is 3-5 inches
- Standard floor tile is 12x12 or 18x18 inches
- Standard light switch height is 48 inches from floor
- Standard outlet height is 12-16 inches from floor
- Typical furniture sizes for scale: sofa ~84-96 inches, dining table ~36x60 inches
- If visible, count floor tiles or planks for measurements

Return ONLY valid JSON with this exact structure:
{"name":"Room type","length_ft":0,"width_ft":0,"confidence":"medium","notes":"Brief explanation"}

- name: Your best guess of the room type (e.g., "Living Room", "Master Bedroom", "Dining Room", "Office")
- length_ft: The longer wall dimension in feet (round to nearest 0.5)
- width_ft: The shorter wall dimension in feet (round to nearest 0.5)
- confidence: "high" if clear reference objects visible, "medium" if reasonable estimate, "low" if very uncertain
- notes: Brief note about what reference cues you used

Do NOT return 0 for any dimension.`,
            },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    if (response.status === 401) throw new Error('Invalid Anthropic API key.')
    throw new Error(`AI request failed: ${err}`)
  }

  const data = await response.json()
  const text = data.content?.[0]?.text || '{}'

  let jsonStr = text.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  try {
    const result = JSON.parse(jsonStr)
    return {
      name: typeof result.name === 'string' ? result.name : 'Room',
      length_ft: Math.max(1, Math.round((Number(result.length_ft) || 0) * 2) / 2),
      width_ft: Math.max(1, Math.round((Number(result.width_ft) || 0) * 2) / 2),
      confidence: ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'low',
      notes: typeof result.notes === 'string' ? result.notes : '',
    }
  } catch {
    throw new Error('Failed to parse AI room estimate. Please try again.')
  }
}

// ---- Fallback dimension lookup: web scraping + AI text + built-in table ----

/**
 * Built-in common furniture dimensions (inches).
 * Used as ultimate fallback when no AI key and no internet.
 */
const COMMON_DIMENSIONS: Record<string, { l: number; w: number; h: number }> = {
  // Living room
  'sofa': { l: 84, w: 36, h: 34 },
  'couch': { l: 84, w: 36, h: 34 },
  'loveseat': { l: 60, w: 34, h: 34 },
  'sectional': { l: 112, w: 84, h: 34 },
  'recliner': { l: 38, w: 36, h: 40 },
  'armchair': { l: 33, w: 32, h: 34 },
  'accent chair': { l: 28, w: 30, h: 32 },
  'coffee table': { l: 48, w: 24, h: 18 },
  'end table': { l: 22, w: 22, h: 24 },
  'side table': { l: 22, w: 22, h: 24 },
  'console table': { l: 48, w: 14, h: 30 },
  'tv stand': { l: 60, w: 18, h: 24 },
  'media console': { l: 60, w: 18, h: 24 },
  'bookshelf': { l: 36, w: 12, h: 72 },
  'bookcase': { l: 36, w: 12, h: 72 },
  'entertainment center': { l: 72, w: 20, h: 60 },
  'ottoman': { l: 24, w: 24, h: 18 },
  'floor lamp': { l: 15, w: 15, h: 62 },
  'table lamp': { l: 12, w: 12, h: 26 },
  // Bedroom
  'king bed': { l: 80, w: 76, h: 50 },
  'queen bed': { l: 80, w: 60, h: 50 },
  'full bed': { l: 75, w: 54, h: 50 },
  'twin bed': { l: 75, w: 38, h: 45 },
  'dresser': { l: 60, w: 18, h: 34 },
  'chest of drawers': { l: 36, w: 18, h: 50 },
  'nightstand': { l: 24, w: 18, h: 26 },
  'wardrobe': { l: 48, w: 24, h: 72 },
  'vanity': { l: 42, w: 20, h: 30 },
  'mirror': { l: 30, w: 2, h: 40 },
  // Dining
  'dining table': { l: 72, w: 36, h: 30 },
  'kitchen table': { l: 48, w: 30, h: 30 },
  'dining chair': { l: 20, w: 18, h: 38 },
  'bar stool': { l: 16, w: 16, h: 30 },
  'counter stool': { l: 16, w: 16, h: 26 },
  'buffet': { l: 54, w: 18, h: 34 },
  'sideboard': { l: 54, w: 18, h: 34 },
  'china cabinet': { l: 42, w: 16, h: 72 },
  'hutch': { l: 42, w: 18, h: 72 },
  // Office
  'desk': { l: 60, w: 30, h: 30 },
  'office chair': { l: 24, w: 24, h: 42 },
  'filing cabinet': { l: 18, w: 26, h: 29 },
  'office desk': { l: 60, w: 30, h: 30 },
  // Outdoor
  'patio table': { l: 48, w: 48, h: 29 },
  'patio chair': { l: 24, w: 22, h: 34 },
  'outdoor sofa': { l: 72, w: 32, h: 32 },
  'lounge chair': { l: 70, w: 28, h: 14 },
  // Bathroom
  'bathroom vanity': { l: 36, w: 21, h: 34 },
  'linen cabinet': { l: 24, w: 16, h: 64 },
  // General
  'rug': { l: 96, w: 60, h: 1 },
  'area rug': { l: 96, w: 60, h: 1 },
  'shelf': { l: 36, w: 10, h: 36 },
  'bench': { l: 48, w: 16, h: 18 },
  'storage bench': { l: 42, w: 16, h: 18 },
}

/**
 * Look up dimensions from built-in table by matching item name keywords.
 */
export function lookupCommonDimensions(name: string, category?: string): AIDimensions | null {
  const lower = (name + ' ' + (category || '')).toLowerCase()

  // Try exact match first, then partial match
  for (const [key, dims] of Object.entries(COMMON_DIMENSIONS)) {
    if (lower.includes(key)) {
      return {
        length_inches: dims.l,
        width_inches: dims.w,
        height_inches: dims.h,
        confidence: 'low' as const,
        notes: `Standard ${key} dimensions from built-in database`,
      }
    }
  }

  return null
}

/**
 * Search the web for item dimensions via the Vercel API endpoint.
 * Falls back gracefully if the API is unavailable.
 */
export async function lookupDimensionsFromWeb(itemName: string): Promise<AIDimensions | null> {
  try {
    const response = await fetch('/api/lookup-dimensions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: itemName }),
    })

    if (!response.ok) return null

    const data = await response.json()
    const results = data.results as Array<{
      length_inches: number
      width_inches: number
      height_inches: number
      product_name: string
    }>

    if (results && results.length > 0) {
      const best = results[0]
      return {
        length_inches: best.length_inches,
        width_inches: best.width_inches,
        height_inches: best.height_inches || 0,
        confidence: 'medium',
        notes: `Found online: "${best.product_name}"`,
      }
    }
  } catch {
    // API not available (local dev, network error, etc.)
  }
  return null
}

/**
 * Ask Claude (text only, no image) to estimate dimensions by item name.
 * Cheaper than vision since no image is processed.
 */
export async function estimateDimensionsByName(
  itemName: string,
  category?: string,
  subcategory?: string,
): Promise<AIDimensions> {
  const apiKey = getAnthropicKey()
  if (!apiKey) {
    throw new Error('Anthropic API key not configured.')
  }

  const context = [
    itemName,
    category ? `Category: ${category}` : '',
    subcategory ? `Type: ${subcategory}` : '',
  ].filter(Boolean).join('. ')

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `You are a furniture dimensions expert. Based on common manufacturer specifications and retail listings, estimate the typical dimensions of this item:

"${context}"

Search your knowledge of furniture catalogs, retailer product pages (Wayfair, IKEA, Ashley, Pottery Barn, Crate & Barrel, etc.), and standard furniture sizing.

Return ONLY valid JSON:
{"length_inches":0,"width_inches":0,"height_inches":0,"confidence":"medium","notes":"Source or reasoning"}

- length_inches: Longest horizontal dimension
- width_inches: Shorter horizontal dimension
- height_inches: Vertical dimension
- confidence: "high" if very standard item, "medium" if reasonable estimate, "low" if unusual item
- notes: What standard/product you based this on

Round to nearest inch. Do NOT return 0.`,
        },
      ],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`AI request failed: ${err}`)
  }

  const data = await response.json()
  const text = data.content?.[0]?.text || '{}'

  let jsonStr = text.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  const result = JSON.parse(jsonStr)
  return {
    length_inches: Math.max(1, Math.round(Number(result.length_inches) || 0)),
    width_inches: Math.max(1, Math.round(Number(result.width_inches) || 0)),
    height_inches: Math.max(1, Math.round(Number(result.height_inches) || 0)),
    confidence: ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'medium',
    notes: typeof result.notes === 'string' ? result.notes : 'AI text-based estimate',
  }
}

/**
 * Smart dimension lookup with cascading fallbacks:
 * 1. Web scraping (Vercel API)
 * 2. AI text lookup (Claude, no image)
 * 3. Built-in common dimensions table
 */
export async function lookupDimensions(
  itemName: string,
  category?: string,
  subcategory?: string,
): Promise<AIDimensions> {
  // Try web scraping first (no API key needed, uses Vercel endpoint)
  const webResult = await lookupDimensionsFromWeb(itemName)
  if (webResult && webResult.length_inches > 0) {
    return webResult
  }

  // Try AI text estimate (needs API key but no image)
  if (isAIConfigured()) {
    try {
      return await estimateDimensionsByName(itemName, category, subcategory)
    } catch {
      // AI failed, fall through
    }
  }

  // Fall back to built-in table
  const builtIn = lookupCommonDimensions(itemName, category)
  if (builtIn) return builtIn

  throw new Error('Could not find dimensions. Try adding a photo for AI measurement, or enter dimensions manually.')
}

// ---- MagicPlan integration ----

/**
 * Get the appropriate MagicPlan link.
 * On mobile it tries the app deep link; on desktop it opens the web app.
 */
export function getMagicPlanLink(): string {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
  if (isMobile) {
    // Universal link that opens the app or redirects to app store
    return 'https://www.magicplan.app'
  }
  return 'https://www.magicplan.app'
}

/**
 * Parse dimension text that a user copies from MagicPlan or any measurement app.
 * Handles a wide variety of formats:
 *   "84 x 36 x 30"        → { l: 84, w: 36, h: 30 }
 *   "7' x 3' x 2.5'"      → { l: 84, w: 36, h: 30 }
 *   "84" x 36" x 30""     → { l: 84, w: 36, h: 30 }
 *   "L: 84  W: 36  H: 30" → { l: 84, w: 36, h: 30 }
 *   "2.1m x 0.9m x 0.76m" → { l: 83, w: 35, h: 30 }  (metric conversion)
 *   "213 x 91 x 76 cm"    → { l: 84, w: 36, h: 30 }
 */
export function parseDimensionText(text: string): AIDimensions | null {
  if (!text || !text.trim()) return null

  const cleaned = text.trim()

  // Check if metric (cm or m)
  const isCm = /cm/i.test(cleaned)
  const isMeters = /\bm\b/i.test(cleaned) && !isCm
  const isFeet = /['′ft]/i.test(cleaned)

  // Extract all numbers from the text
  const numbers: number[] = []
  const numPattern = /(\d+(?:[.,]\d+)?)/g
  let match: RegExpExecArray | null

  while ((match = numPattern.exec(cleaned)) !== null) {
    numbers.push(parseFloat(match[1].replace(',', '.')))
  }

  if (numbers.length < 2) return null

  let dims: number[]

  if (isCm) {
    // Convert cm to inches (1 cm = 0.3937 in)
    dims = numbers.slice(0, 3).map(n => Math.round(n * 0.3937))
  } else if (isMeters) {
    // Convert meters to inches (1 m = 39.37 in)
    dims = numbers.slice(0, 3).map(n => Math.round(n * 39.37))
  } else if (isFeet) {
    // Check for feet'inches" pattern like 7'0" x 3'0"
    const ftInPattern = /(\d+)[′']\s*(\d+)?[″"]?/g
    const ftInNums: number[] = []
    let ftMatch: RegExpExecArray | null
    while ((ftMatch = ftInPattern.exec(cleaned)) !== null) {
      const feet = parseFloat(ftMatch[1])
      const inches = ftMatch[2] ? parseFloat(ftMatch[2]) : 0
      ftInNums.push(feet * 12 + inches)
    }
    dims = ftInNums.length >= 2 ? ftInNums.slice(0, 3) : numbers.slice(0, 3).map(n => Math.round(n * 12))
  } else {
    // Assume inches
    dims = numbers.slice(0, 3).map(n => Math.round(n))
  }

  // Sanity check: all dimensions should be 1-300 inches
  if (!dims.every(d => d >= 1 && d <= 300)) return null

  // Sort: longest = length, middle = width, shortest = height
  dims.sort((a, b) => b - a)

  return {
    length_inches: dims[0],
    width_inches: dims[1] || 0,
    height_inches: dims[2] || 0,
    confidence: 'high',
    notes: 'Imported from measurement app',
  }
}

export interface AIIdentifiedItem {
  name: string
  category: 'kitchen & dining' | 'bedroom' | 'living room' | 'office' | 'bathroom' | 'outdoor' | 'other'
  subcategory: string
  estimated_value: number
  quantity: number
  condition: 'excellent' | 'good' | 'fair' | 'poor'
  description: string
  useful_life_years: number
}

/**
 * Send an image to Claude's vision API to identify staging items.
 * Calls the Anthropic API directly with browser access enabled.
 */
export async function identifyItemsFromImage(imageBase64: string): Promise<AIIdentifiedItem[]> {
  const apiKey = getAnthropicKey()
  if (!apiKey) {
    throw new Error('Anthropic API key not configured. Go to Settings to add your key.')
  }

  // Extract the base64 data and media type from the data URL
  const match = imageBase64.match(/^data:(image\/\w+);base64,(.+)/)
  if (!match) {
    throw new Error('Invalid image format')
  }

  const mediaType = match[1]
  const base64Data = match[2]

  // Call the Anthropic API directly (works on static hosts like GitHub Pages)
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data,
              },
            },
            {
              type: 'text',
              text: `You are an expert home staging inventory specialist. Analyze this image and identify EVERY individual item you can see that would be part of a home staging inventory.

For each item, provide ALL of these fields:
- name: A clear, descriptive name including color, material, and style (e.g., "Gray Linen Mid-Century Sofa", "Antique Brass Table Lamp", "White Ceramic Textured Vase")
- category: EXACTLY one of: "kitchen & dining", "bedroom", "living room", "office", "bathroom", "outdoor", "other"
- subcategory: A specific sub-type within the category (e.g., "seating", "tables", "lighting", "rugs", "wall art", "bedding", "cookware", "storage", "decor", "textiles")
- estimated_value: Your best estimate of the retail/replacement value in USD (as a number, no $ sign)
- quantity: How many of this exact item you see (default 1)
- condition: One of: "excellent", "good", "fair", "poor" — judge from visual appearance
- description: A brief description with dimensions estimate, material, color, and any notable features (e.g., "Charcoal gray linen 3-seat sofa, approx 84in wide, tapered wood legs, removable cushions")
- useful_life_years: Estimated useful life in years for depreciation (furniture: 7, electronics: 5, textiles/linens: 3, art/decor: 10, appliances: 5, outdoor: 5)

If this is a receipt or document (not a photo of items), extract the items and prices from it instead.

Respond with ONLY a valid JSON array, no markdown, no explanation. Example:
[{"name":"Gray Linen Mid-Century Sofa","category":"living room","subcategory":"seating","estimated_value":899,"quantity":1,"condition":"good","description":"Charcoal gray linen 3-seat sofa, approx 84in wide, tapered wood legs","useful_life_years":7}]

If you cannot identify any items, respond with an empty array: []`,
            },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    if (response.status === 401) {
      throw new Error('Invalid Anthropic API key. Check your key in Settings.')
    }
    throw new Error(`AI request failed: ${err}`)
  }

  const data = await response.json()
  const text = data.content?.[0]?.text || '[]'

  // Parse the JSON response, handling potential markdown wrapping
  let jsonStr = text.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  try {
    const items: AIIdentifiedItem[] = JSON.parse(jsonStr)
    // Validate and sanitize
    const validCategories = ['kitchen & dining', 'bedroom', 'living room', 'office', 'bathroom', 'outdoor', 'other']
    const validConditions = ['excellent', 'good', 'fair', 'poor']
    return items
      .filter((item) => item.name && typeof item.name === 'string')
      .map((item) => ({
        name: item.name,
        category: validCategories.includes(item.category) ? item.category : 'other',
        subcategory: typeof item.subcategory === 'string' ? item.subcategory : '',
        estimated_value: typeof item.estimated_value === 'number' && item.estimated_value > 0 ? item.estimated_value : 0,
        quantity: typeof item.quantity === 'number' && item.quantity >= 1 ? item.quantity : 1,
        condition: validConditions.includes(item.condition) ? item.condition : 'good',
        description: typeof item.description === 'string' ? item.description : '',
        useful_life_years: typeof item.useful_life_years === 'number' && item.useful_life_years >= 1 ? item.useful_life_years : 7,
      })) as AIIdentifiedItem[]
  } catch {
    throw new Error('Failed to parse AI response. Please try again.')
  }
}
