import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Google Calendar proxy — keeps OAuth client secret server-side.
 *
 * All requests require Authorization header with a valid Google access token.
 *
 * GET  /api/calendar?action=list&timeMin=...&timeMax=...  → list events
 * GET  /api/calendar?action=freebusy&timeMin=...&timeMax=... → check availability
 * POST /api/calendar  { action: 'create', event: {...} }  → create event
 * POST /api/calendar  { action: 'update', eventId, event } → update event
 * POST /api/calendar  { action: 'delete', eventId }       → delete event
 */

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

function getAccessToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  return (req.headers['x-access-token'] as string) || null
}

async function calendarFetch(url: string, token: string, options: RequestInit = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const data = await res.json()
  if (!res.ok) return { error: true, status: res.status, data }
  return { error: false, status: res.status, data }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = getAccessToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Missing access token. Include Authorization: Bearer <token>' })
  }

  // ---------- GET: list events or check availability ----------
  if (req.method === 'GET') {
    const { action, timeMin, timeMax, calendarId = 'primary', maxResults = '50' } = req.query as Record<string, string>

    if (action === 'freebusy') {
      const result = await calendarFetch(`${CALENDAR_API}/freeBusy`, token, {
        method: 'POST',
        body: JSON.stringify({
          timeMin: timeMin || new Date().toISOString(),
          timeMax: timeMax || new Date(Date.now() + 7 * 86400000).toISOString(),
          items: [{ id: calendarId }],
        }),
      })
      if (result.error) return res.status(result.status).json(result.data)
      return res.status(200).json(result.data)
    }

    // Default: list events
    const params = new URLSearchParams({
      timeMin: timeMin || new Date().toISOString(),
      timeMax: timeMax || new Date(Date.now() + 30 * 86400000).toISOString(),
      maxResults,
      singleEvents: 'true',
      orderBy: 'startTime',
    })

    const result = await calendarFetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      token,
    )
    if (result.error) return res.status(result.status).json(result.data)
    return res.status(200).json(result.data)
  }

  // ---------- POST: create, update, delete events ----------
  if (req.method === 'POST') {
    const { action, event, eventId, calendarId = 'primary' } = req.body || {}

    if (action === 'create') {
      if (!event) return res.status(400).json({ error: 'Missing event object' })

      const result = await calendarFetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        token,
        { method: 'POST', body: JSON.stringify(event) },
      )
      if (result.error) return res.status(result.status).json(result.data)
      return res.status(201).json(result.data)
    }

    if (action === 'update') {
      if (!eventId || !event) return res.status(400).json({ error: 'Missing eventId or event' })

      const result = await calendarFetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        token,
        { method: 'PATCH', body: JSON.stringify(event) },
      )
      if (result.error) return res.status(result.status).json(result.data)
      return res.status(200).json(result.data)
    }

    if (action === 'delete') {
      if (!eventId) return res.status(400).json({ error: 'Missing eventId' })

      const delRes = await fetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      )

      if (!delRes.ok && delRes.status !== 204) {
        const data = await delRes.json().catch(() => ({}))
        return res.status(delRes.status).json(data)
      }
      return res.status(204).end()
    }

    return res.status(400).json({ error: 'Unknown action. Use create, update, or delete.' })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
