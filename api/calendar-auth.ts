import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Google Calendar OAuth flow.
 *
 * GET  /api/calendar-auth?action=login   → redirect to Google consent screen
 * GET  /api/calendar-auth?code=...       → exchange code for tokens (callback)
 * POST /api/calendar-auth                → refresh an expired access token
 */

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const SCOPES = 'https://www.googleapis.com/auth/calendar'

function getRedirectUri(req: VercelRequest) {
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000'
  return `${proto}://${host}/api/calendar-auth`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({
      error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.',
    })
  }

  const redirectUri = getRedirectUri(req)

  // Step 1: Redirect user to Google consent screen
  if (req.method === 'GET' && req.query.action === 'login') {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
    })
    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  }

  // Step 2: Handle OAuth callback — exchange code for tokens
  if (req.method === 'GET' && req.query.code) {
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code as string,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      })

      const tokens = await tokenRes.json()

      if (!tokenRes.ok) {
        return res.status(tokenRes.status).json({ error: 'Token exchange failed', details: tokens })
      }

      // Return an HTML page that stores tokens in localStorage and closes
      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Calendar Connected</title>
        <style>
          body { background: #1e1b4b; color: #e2e8f0; font-family: -apple-system, sans-serif;
                 display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { text-align: center; padding: 2rem; }
          h1 { color: #a5b4fc; margin-bottom: 1rem; }
        </style>
        </head>
        <body>
          <div class="card">
            <h1>Calendar Connected!</h1>
            <p>You can close this window.</p>
          </div>
          <script>
            try {
              const tokens = ${JSON.stringify(tokens)};
              tokens.expires_at = Date.now() + (tokens.expires_in * 1000);
              localStorage.setItem('google_calendar_tokens', JSON.stringify(tokens));
              if (window.opener) {
                window.opener.postMessage({ type: 'google-calendar-connected', tokens }, '*');
                setTimeout(() => window.close(), 1500);
              }
            } catch(e) { console.error(e); }
          </script>
        </body>
        </html>
      `)
    } catch (err) {
      return res.status(500).json({ error: 'OAuth callback failed' })
    }
  }

  // Step 3: Refresh an expired access token
  if (req.method === 'POST') {
    const { refresh_token } = req.body || {}
    if (!refresh_token) {
      return res.status(400).json({ error: 'Missing refresh_token' })
    }

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'refresh_token',
        }),
      })

      const tokens = await tokenRes.json()
      if (!tokenRes.ok) {
        return res.status(tokenRes.status).json({ error: 'Token refresh failed', details: tokens })
      }

      tokens.expires_at = Date.now() + (tokens.expires_in * 1000)
      return res.status(200).json(tokens)
    } catch {
      return res.status(500).json({ error: 'Token refresh failed' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
