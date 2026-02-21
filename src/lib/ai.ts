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
  estimated_value: number
  quantity: number
  condition: 'excellent' | 'good' | 'fair' | 'poor'
}

/**
 * Send an image to Claude's vision API to identify staging items.
 * Calls our Vercel API proxy to avoid CORS issues.
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

For each item, provide:
- name: A clear, descriptive name (e.g., "Gray Linen Sofa", "Brass Table Lamp", "White Ceramic Vase")
- category: EXACTLY one of: "kitchen & dining", "bedroom", "living room", "office", "bathroom", "outdoor", "other"
- estimated_value: Your best estimate of the retail/replacement value in USD (as a number, no $ sign)
- quantity: How many of this exact item you see (default 1)
- condition: One of: "excellent", "good", "fair", "poor"

If this is a receipt or document (not a photo of items), extract the items and prices from it instead.

Respond with ONLY a valid JSON array, no markdown, no explanation. Example:
[{"name":"Gray Linen Sofa","category":"living room","estimated_value":899,"quantity":1,"condition":"good"}]

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
        estimated_value: typeof item.estimated_value === 'number' && item.estimated_value > 0 ? item.estimated_value : 0,
        quantity: typeof item.quantity === 'number' && item.quantity >= 1 ? item.quantity : 1,
        condition: validConditions.includes(item.condition) ? item.condition : 'good',
      })) as AIIdentifiedItem[]
  } catch {
    throw new Error('Failed to parse AI response. Please try again.')
  }
}
