import type { VercelRequest, VercelResponse } from "@vercel/node";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const SCOPES = "https://www.googleapis.com/auth/calendar";

export function GET(req: VercelRequest, res: VercelResponse) {
  const url = new URL(req.url!, `https://${req.headers.host}`);
  const action = url.searchParams.get("action");

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: "Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." });
  }

  if (action === "consent") {
    const redirectUri = `https://${req.headers.host}/api/calendar-auth`;
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
    });
    return res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  }

  const code = url.searchParams.get("code");
  if (code) {
    return handleCallback(req, res, code);
  }

  return res.status(400).json({ error: "Missing action or code parameter" });
}

export async function POST(req: VercelRequest, res: VercelResponse) {
  const { refresh_token } = req.body || {};
  if (!refresh_token) {
    return res.status(400).json({ error: "Missing refresh_token" });
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const data = await tokenRes.json();
  if (!tokenRes.ok) {
    return res.status(tokenRes.status).json({ error: data.error_description || data.error });
  }

  return res.json({
    access_token: data.access_token,
    expires_in: data.expires_in,
  });
}

async function handleCallback(req: VercelRequest, res: VercelResponse, code: string) {
  const redirectUri = `https://${req.headers.host}/api/calendar-auth`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const data = await tokenRes.json();
  if (!tokenRes.ok) {
    return res.status(400).send(`<h2>Auth failed</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
  }

  const html = `<!DOCTYPE html>
<html><head><title>Connected</title>
<style>
  body { font-family: system-ui; background: #1e1b4b; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { text-align: center; padding: 2rem; }
  h2 { color: #a78bfa; }
</style></head><body>
<div class="box">
  <h2>Google Calendar Connected</h2>
  <p>You can close this window.</p>
</div>
<script>
  const tokens = ${JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in })};
  if (window.opener) {
    window.opener.postMessage({ type: 'google-calendar-tokens', ...tokens }, '*');
  }
  localStorage.setItem('gcal_tokens', JSON.stringify(tokens));
  setTimeout(() => window.close(), 2000);
</script>
</body></html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
}
