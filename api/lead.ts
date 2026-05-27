// POST /api/lead
//
// Speed-to-lead intake webhook. Accepts a lead from any source (website
// form, Zillow/Realtor/Redfin, Facebook/Google lead ads, IG/FB DMs),
// instantly scores and routes it, drafts the first response (<60s SLA),
// generates the 7-21 touch follow-up cadence, fires an instant operator
// alert to Telegram, and — when explicitly enabled — syncs to GHL.
//
// Auth (any one):
//   - Mission Control bearer/cookie (getAuthState), or
//   - LEAD_WEBHOOK_SECRET via `x-webhook-secret` header or `?key=` query.
// If MISSION_CONTROL_TOKEN is unset and no secret is configured, the
// endpoint is open (matches the rest of the dashboard's dev behavior).
//
// Execution is dry-run by default. Pass `?execute=true` (or body.execute,
// or set LEAD_AUTOEXECUTE=on) to perform GHL writes.

import { getAuthState } from "./services/auth.js";
import { runLeadIntake } from "./services/lead-intake.js";
import type { IntakeResult } from "./services/lead-intake.js";
import { sendTelegram } from "./services/notify.js";
import { leadFullName } from "./services/lead-types.js";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isAuthorized(req: Request, url: URL): boolean {
  const auth = getAuthState(req);
  if (auth.authenticated) return true; // valid MC token, or auth not required

  const secret = process.env.LEAD_WEBHOOK_SECRET;
  if (secret) {
    const provided = req.headers.get("x-webhook-secret") || url.searchParams.get("key") || "";
    if (provided && timingSafeEqual(provided, secret)) return true;
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function parseBody(req: Request): Promise<Record<string, unknown> | null> {
  const ctype = req.headers.get("content-type") || "";
  try {
    if (ctype.includes("application/json")) {
      return (await req.json()) as Record<string, unknown>;
    }
    if (
      ctype.includes("application/x-www-form-urlencoded") ||
      ctype.includes("multipart/form-data")
    ) {
      const form = await req.formData();
      const obj: Record<string, unknown> = {};
      for (const [k, v] of form.entries()) obj[k] = typeof v === "string" ? v : v.name;
      return obj;
    }
    // Fall back to attempting JSON.
    const text = await req.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function truthy(v: string | null | undefined): boolean {
  return /^(on|true|1|yes)$/i.test(v ?? "");
}

function alertText(result: IntakeResult): string {
  const { lead, score, routing, cadence } = result;
  const emoji = score.priority === "hot" ? "🔥" : score.priority === "warm" ? "⚡" : "🌱";
  const contact = [lead.phone, lead.email].filter(Boolean).join(" · ") || "no contact info";
  const first = result.firstResponse;
  return (
    `${emoji} *New ${score.priority.toUpperCase()} lead* — ${leadFullName(lead)}\n` +
    `Score ${score.score}/100 (grade ${score.grade}) · ${lead.type} · ${lead.source}\n` +
    `${contact}\n` +
    (lead.propertyAddress ? `🏠 ${lead.propertyAddress}\n` : "") +
    `➡️ ${routing.pipeline} · ${routing.queue} queue\n` +
    `📋 ${cadence.summary.total} touches over ${cadence.summary.spanDays}d ` +
    `(${cadence.summary.bySms} SMS · ${cadence.summary.byEmail} email · ${cadence.summary.byCall} calls)\n` +
    (first ? `\n💬 First response (${first.channel}):\n${first.body}` : "")
  );
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (!isAuthorized(req, url)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await parseBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);

  // A lead needs at least one way to identify/reach the person.
  const hasIdentity =
    body.email || body.phone || body.name || body.firstName || body.first_name || body.message;
  if (!hasIdentity) {
    return json(
      { error: "Lead must include at least one of: email, phone, name, or message" },
      400
    );
  }

  const execute =
    truthy(url.searchParams.get("execute")) ||
    body.execute === true ||
    truthy(process.env.LEAD_AUTOEXECUTE);

  const sourceHint = url.searchParams.get("source") ?? undefined;

  let result: IntakeResult;
  try {
    result = await runLeadIntake(body, { sourceHint, execute });
  } catch (e) {
    console.error("[SPEED-TO-LEAD] intake failed:", (e as Error).message);
    return json({ error: "intake processing failed", detail: (e as Error).message }, 500);
  }

  console.log(
    `[SPEED-TO-LEAD] ${JSON.stringify({
      name: leadFullName(result.lead),
      source: result.lead.source,
      type: result.lead.type,
      score: result.score.score,
      grade: result.score.grade,
      priority: result.score.priority,
      pipeline: result.routing.pipeline,
      touches: result.cadence.summary.total,
      executed: execute && result.execution.ghlConfigured,
    })}`
  );

  // Instant operator alert — proven path, fires regardless of GHL config.
  await sendTelegram(alertText(result));

  return json(
    {
      ok: true,
      lead: result.lead,
      score: result.score,
      routing: result.routing,
      firstResponse: result.firstResponse,
      cadence: result.cadence,
      execution: result.execution,
      slaFirstTouchSeconds: result.slaFirstTouchSeconds,
    },
    201
  );
}

export { handler as POST };
