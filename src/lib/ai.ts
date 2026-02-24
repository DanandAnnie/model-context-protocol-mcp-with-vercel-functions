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
