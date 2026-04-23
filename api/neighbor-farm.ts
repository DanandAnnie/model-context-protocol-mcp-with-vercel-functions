// POST /api/neighbor-farm
//
// Accepts listing data from GHL, Rex, or Claude.
// Logs the trigger, sends an immediate Telegram confirmation to Dan,
// and queues a 24-hour follow-up reminder in a local JSONL file.
//
// Phase 2 stub: Vortex GeoLeads pull + Mojo Sync automation is deferred.

import { getAuthState } from "./services/auth.js";

interface NeighborFarmPayload {
  address: string;
  firstName?: string;
  lastName?: string;
  opportunityId?: string;
  triggerSource?: string;
}

interface QueueEntry extends NeighborFarmPayload {
  listName: string;
  scheduledReminderAt: string;
  receivedAt: string;
  reminderText: string;
  chatId: string;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }

  const auth = getAuthState(req);
  if (!auth.authenticated) {
    return json({ error: "Unauthorized" }, 401);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const body = raw as Record<string, unknown>;
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!address) {
    return json({ error: "address is required" }, 400);
  }

  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : undefined;
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : undefined;
  const opportunityId = typeof body.opportunityId === "string" ? body.opportunityId.trim() : undefined;
  const triggerSource = typeof body.triggerSource === "string" ? body.triggerSource.trim() : undefined;

  const addressSlug = address.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const listName = `${lastName || "Listing"} - ${addressSlug}`;

  const receivedAt = new Date();
  const scheduledReminderAt = nextEightAMMountain(receivedAt);

  console.log(
    `[NEIGHBOR-FARM] ${JSON.stringify({
      address, firstName, lastName, opportunityId, triggerSource,
      listName, receivedAt: receivedAt.toISOString(),
      scheduledReminderAt: scheduledReminderAt.toISOString(),
    })}`
  );

  const chatId = process.env.TELEGRAM_CHAT_ID || "8208280469";
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  const reminderText =
    `📍 Neighbor farm reminder — yesterday you added ${address} to the system. ` +
    `Still need to run the 50-nearest Vortex GeoLeads pull + Mojo Sync? ` +
    `If yes, reply here and I'll get it queued.`;

  // Enqueue the 24-hour reminder regardless of Telegram status
  const entry: QueueEntry = {
    address, firstName, lastName, opportunityId, triggerSource,
    listName,
    scheduledReminderAt: scheduledReminderAt.toISOString(),
    receivedAt: receivedAt.toISOString(),
    reminderText,
    chatId,
  };
  writeFallbackQueue(entry);

  // Send immediate Telegram confirmation (proves webhook fired cleanly)
  if (botToken) {
    const confirmText =
      `✅ Neighbor farm triggered for *${address}*\n` +
      `Source: ${triggerSource || "unknown"} | List: ${listName}\n` +
      `24h reminder queued for ${scheduledReminderAt.toLocaleString("en-US", { timeZone: "America/Denver" })} MT\n` +
      `_Vortex + Mojo automation deferred to Phase 2_`;
    try {
      await sendTelegram(botToken, chatId, confirmText);
    } catch (e) {
      console.error("[NEIGHBOR-FARM] Telegram confirmation failed:", (e as Error).message);
    }
  } else {
    console.warn("[NEIGHBOR-FARM] TELEGRAM_BOT_TOKEN not set — skipping confirmation message");
  }

  // TODO: Phase 2 — Vortex + Mojo automation
  // 1. Call Vortex GeoLeads API: search 50 nearest addresses to `address`
  // 2. Build contact list from GeoLeads results
  // 3. Sync list to Mojo Dialer for calling campaign
  // 4. Optionally tag the GHL opportunity `opportunityId` with list status

  return json(
    {
      listName,
      scheduledReminderAt: scheduledReminderAt.toISOString(),
      triggerSource: triggerSource ?? null,
      message: "Vortex + Mojo automation deferred to Phase 2 — reminder scheduled.",
    },
    201
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function sendTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) {
    throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  }
}

function writeFallbackQueue(entry: QueueEntry): void {
  // In serverless (Vercel), the filesystem is not writable — emit as a structured
  // log line so nothing is lost. The daily scheduled task reads this prefix from
  // Vercel log drains / local vercel dev output.
  console.log(`[NEIGHBOR-FARM-QUEUE] ${JSON.stringify(entry)}`);
}

// Returns next 8:00 AM Mountain Time (America/Denver) from a given Date.
// If it's already past 8 AM MT today, returns tomorrow's 8 AM.
function nextEightAMMountain(from: Date): Date {
  const tz = "America/Denver";

  const mtParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(from);

  const mtHour = parseInt(mtParts.find((p) => p.type === "hour")!.value);
  const addDays = mtHour < 8 ? 0 : 1;

  const shifted = new Date(from.getTime() + addDays * 86_400_000);
  const dayParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(shifted);

  const y = parseInt(dayParts.find((p) => p.type === "year")!.value);
  const mo = parseInt(dayParts.find((p) => p.type === "month")!.value) - 1; // 0-indexed
  const d = parseInt(dayParts.find((p) => p.type === "day")!.value);

  // Probe: noon UTC on that day → find MT hour to derive offset
  const noonUTC = new Date(Date.UTC(y, mo, d, 12, 0, 0));
  const noonMTHour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "2-digit", hour12: false,
    }).format(noonUTC)
  );
  const utcOffsetHours = 12 - noonMTHour; // 6 for MDT (UTC-6), 7 for MST (UTC-7)

  return new Date(Date.UTC(y, mo, d, 8 + utcOffsetHours, 0, 0));
}
