import type { VercelRequest, VercelResponse } from '@vercel/node'

// Web scraping endpoint to find furniture dimensions from product listings
// Searches DuckDuckGo for the item and extracts dimension patterns from results

interface DimensionResult {
  length_inches: number
  width_inches: number
  height_inches: number
  source: string
  product_name: string
}

// Common dimension patterns in product descriptions
// Matches: 84"W x 36"D x 30"H, 84 x 36 x 30 inches, 7'L x 3'W, etc.
function extractDimensions(text: string): { l: number; w: number; h: number } | null {
  // Pattern: NxNxN with optional units (inches, in, ", cm)
  const patterns = [
    // 84"W x 36"D x 30"H or 84" x 36" x 30"
    /(\d+(?:\.\d+)?)\s*"?\s*[WwLl]?\s*[xX×]\s*(\d+(?:\.\d+)?)\s*"?\s*[DdWw]?\s*[xX×]\s*(\d+(?:\.\d+)?)\s*"?\s*[Hh]?/,
    // 84 x 36 x 30 inches/in
    /(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(?:inches|inch|in\b|")/i,
    // W: 84" D: 36" H: 30" or Width: 84 Depth: 36 Height: 30
    /[Ww](?:idth)?[:\s]*(\d+(?:\.\d+)?)\s*"?\s*[,;]?\s*[Dd](?:epth)?[:\s]*(\d+(?:\.\d+)?)\s*"?\s*[,;]?\s*[Hh](?:eight)?[:\s]*(\d+(?:\.\d+)?)/,
    // L x W x H format
    /[Ll](?:ength)?[:\s]*(\d+(?:\.\d+)?)\s*"?\s*[,;xX×]\s*[Ww](?:idth)?[:\s]*(\d+(?:\.\d+)?)\s*"?\s*[,;xX×]\s*[Hh](?:eight)?[:\s]*(\d+(?:\.\d+)?)/,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      const nums = [parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3])].sort((a, b) => b - a)
      // Sanity check: furniture should be between 5" and 200"
      if (nums.every(n => n >= 5 && n <= 200)) {
        return { l: nums[0], w: nums[1], h: nums[2] }
      }
    }
  }

  // Two-dimension pattern: NxN (length x width only)
  const twoDimPatterns = [
    /(\d+(?:\.\d+)?)\s*"?\s*[xX×]\s*(\d+(?:\.\d+)?)\s*"?\s*(?:inches|inch|in\b|")/i,
    /(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)\s*(?:inches|inch|in\b|")/i,
  ]

  for (const pattern of twoDimPatterns) {
    const match = text.match(pattern)
    if (match) {
      const a = parseFloat(match[1])
      const b = parseFloat(match[2])
      if (a >= 5 && a <= 200 && b >= 5 && b <= 200) {
        const l = Math.max(a, b)
        const w = Math.min(a, b)
        return { l, w, h: 0 }
      }
    }
  }

  return null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { query } = req.body as { query?: string }
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing query parameter' })
  }

  try {
    const searchQuery = `${query} dimensions inches specifications`
    const encoded = encodeURIComponent(searchQuery)

    // Fetch DuckDuckGo HTML results
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StagingInventoryBot/1.0)',
      },
    })

    if (!response.ok) {
      throw new Error(`Search returned ${response.status}`)
    }

    const html = await response.text()

    // Extract search result snippets
    const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
    const titleRegex = /class="result__a"[^>]*>([\s\S]*?)<\/a>/gi
    const results: DimensionResult[] = []

    const snippets: string[] = []
    let match: RegExpExecArray | null

    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ').trim())
    }

    const titles: string[] = []
    while ((match = titleRegex.exec(html)) !== null) {
      titles.push(match[1].replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ').trim())
    }

    // Try to extract dimensions from each snippet
    for (let i = 0; i < snippets.length && results.length < 3; i++) {
      const fullText = `${titles[i] || ''} ${snippets[i]}`
      const dims = extractDimensions(fullText)
      if (dims) {
        results.push({
          length_inches: Math.round(dims.l),
          width_inches: Math.round(dims.w),
          height_inches: Math.round(dims.h),
          source: 'web',
          product_name: titles[i] || query,
        })
      }
    }

    return res.status(200).json({ results })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return res.status(500).json({ error: message, results: [] })
  }
}
