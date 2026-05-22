import type { VercelRequest, VercelResponse } from "@vercel/node";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

function getToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

export async function GET(req: VercelRequest, res: VercelResponse) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });

  const url = new URL(req.url!, `https://${req.headers.host}`);
  const action = url.searchParams.get("action") || "list";

  if (action === "list") {
    const timeMin = url.searchParams.get("timeMin") || new Date().toISOString();
    const timeMax = url.searchParams.get("timeMax") || new Date(Date.now() + 30 * 86400000).toISOString();
    const calendarId = url.searchParams.get("calendarId") || "primary";

    const params = new URLSearchParams({
      timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "100",
    });

    const apiRes = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json(data);
    return res.json(data);
  }

  if (action === "freebusy") {
    const timeMin = url.searchParams.get("timeMin") || new Date().toISOString();
    const timeMax = url.searchParams.get("timeMax") || new Date(Date.now() + 7 * 86400000).toISOString();

    const apiRes = await fetch(`${CALENDAR_API}/freeBusy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        timeMin, timeMax,
        items: [{ id: "primary" }],
      }),
    });
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json(data);
    return res.json(data);
  }

  return res.status(400).json({ error: "Unknown action. Use 'list' or 'freebusy'." });
}

export async function POST(req: VercelRequest, res: VercelResponse) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });

  const { action, calendarId, eventId, event } = req.body || {};

  if (action === "create") {
    const apiRes = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId || "primary")}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json(data);
    return res.json(data);
  }

  if (action === "update") {
    if (!eventId) return res.status(400).json({ error: "Missing eventId" });
    const apiRes = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId || "primary")}/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json(data);
    return res.json(data);
  }

  if (action === "delete") {
    if (!eventId) return res.status(400).json({ error: "Missing eventId" });
    const apiRes = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId || "primary")}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!apiRes.ok) {
      const data = await apiRes.json().catch(() => ({}));
      return res.status(apiRes.status).json(data);
    }
    return res.json({ success: true });
  }

  return res.status(400).json({ error: "Unknown action. Use 'create', 'update', or 'delete'." });
}
