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
