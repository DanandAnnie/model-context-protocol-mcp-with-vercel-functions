// ============================================================
// Speed-to-Lead — follow-up cadence generator
//
// Produces the next 7-21 touches across SMS, email, and call tasks.
// Touch #1 always fires immediately (offset 0) so the first response
// lands inside the 60-second SLA. Cadence density scales with priority:
// hot leads get the full aggressive sequence, cold leads a lighter one.
// SMS and call touches are clamped to business hours; email can go anytime.
// ============================================================

import type { Lead } from "./lead-types.js";
import { leadFullName } from "./lead-types.js";
import type { ScoreResult, LeadPriority } from "./lead-scoring.js";

export type Channel = "sms" | "email" | "call";

export interface Touch {
  step: number;
  channel: Channel;
  /** Minutes after lead receipt that this touch is scheduled (pre-clamp). */
  offsetMinutes: number;
  scheduledAt: string;
  subject?: string;
  body: string;
  purpose: string;
}

export interface CadenceResult {
  touches: Touch[];
  summary: {
    total: number;
    bySms: number;
    byEmail: number;
    byCall: number;
    spanDays: number;
    firstTouchChannel: Channel;
  };
}

export interface CadenceContext {
  agentName: string;
  agentPhone?: string;
  bookingUrl?: string;
  timezone: string;
}

interface CadenceStep {
  channel: Channel;
  offsetMinutes: number;
  templateKey: string;
  purpose: string;
}

const MIN = 1;
const HOUR = 60;
const DAY = 60 * 24;

// Master 21-step plan. Slices of this are taken by priority. Step 1 is the
// instant response; the rest blend channels and spread out over ~30 days.
const MASTER_PLAN: CadenceStep[] = [
  { channel: "sms", offsetMinutes: 0, templateKey: "instant", purpose: "Instant first response (<60s)" },
  { channel: "email", offsetMinutes: 5 * MIN, templateKey: "intro_email", purpose: "Detailed intro + next step" },
  { channel: "call", offsetMinutes: 30 * MIN, templateKey: "call_task", purpose: "First call attempt" },
  { channel: "sms", offsetMinutes: 4 * HOUR, templateKey: "checkin_sms", purpose: "Same-day nudge" },
  { channel: "call", offsetMinutes: 1 * DAY, templateKey: "call_task", purpose: "Day 2 call attempt" },
  { channel: "email", offsetMinutes: 2 * DAY, templateKey: "value_email", purpose: "Value / market insight" },
  { channel: "sms", offsetMinutes: 3 * DAY, templateKey: "checkin_sms", purpose: "Day 3 check-in" },
  { channel: "call", offsetMinutes: 4 * DAY, templateKey: "call_task", purpose: "Day 4 call attempt" },
  { channel: "email", offsetMinutes: 5 * DAY, templateKey: "value_email", purpose: "Helpful resource" },
  { channel: "sms", offsetMinutes: 6 * DAY, templateKey: "checkin_sms", purpose: "Day 6 check-in" },
  { channel: "call", offsetMinutes: 7 * DAY, templateKey: "call_task", purpose: "Week 1 wrap call" },
  { channel: "email", offsetMinutes: 9 * DAY, templateKey: "value_email", purpose: "Week 2 touch" },
  { channel: "sms", offsetMinutes: 11 * DAY, templateKey: "checkin_sms", purpose: "Still here for you" },
  { channel: "call", offsetMinutes: 13 * DAY, templateKey: "call_task", purpose: "Mid-month call attempt" },
  { channel: "email", offsetMinutes: 15 * DAY, templateKey: "value_email", purpose: "Market update" },
  { channel: "sms", offsetMinutes: 18 * DAY, templateKey: "checkin_sms", purpose: "Light touch" },
  { channel: "call", offsetMinutes: 21 * DAY, templateKey: "call_task", purpose: "Three-week call attempt" },
  { channel: "email", offsetMinutes: 24 * DAY, templateKey: "value_email", purpose: "Re-engagement" },
  { channel: "sms", offsetMinutes: 27 * DAY, templateKey: "checkin_sms", purpose: "Quick check-in" },
  { channel: "call", offsetMinutes: 30 * DAY, templateKey: "breakup_call", purpose: "Break-up call" },
  { channel: "email", offsetMinutes: 30 * DAY + HOUR, templateKey: "breakup_email", purpose: "Break-up / long-term nurture handoff" },
];

const COUNT_BY_PRIORITY: Record<LeadPriority, number> = {
  hot: 21,
  warm: 13,
  cold: 7,
};

function renderTemplate(
  key: string,
  lead: Lead,
  ctx: CadenceContext
): { subject?: string; body: string } {
  const name = lead.firstName || leadFullName(lead);
  const agent = ctx.agentName;
  const prop = lead.propertyAddress;
  const book = ctx.bookingUrl;
  const askVerb =
    lead.type === "seller"
      ? "selling"
      : lead.type === "renter"
      ? "renting"
      : lead.type === "investor"
      ? "your next investment"
      : "your home search";
  const propClause = prop ? ` about ${prop}` : "";

  switch (key) {
    case "instant":
      return {
        body:
          `Hi ${name}, this is ${agent} — thanks for reaching out${propClause}! ` +
          `I just got your message and wanted to connect right away. ` +
          `What's the best time for a quick call today?`,
      };
    case "intro_email":
      return {
        subject: prop ? `Re: ${prop}` : `Following up on ${askVerb}`,
        body:
          `Hi ${name},\n\n` +
          `Thanks for getting in touch${propClause}. I'd love to help with ${askVerb}. ` +
          `I'll give you a quick call shortly, but in the meantime feel free to reply here with any questions` +
          (book ? `, or grab a time directly on my calendar: ${book}` : ".") +
          `\n\nTalk soon,\n${agent}` +
          (ctx.agentPhone ? `\n${ctx.agentPhone}` : ""),
      };
    case "call_task":
      return {
        body:
          `Call ${name}${lead.phone ? ` at ${lead.phone}` : ""}` +
          `${propClause}. Lead type: ${lead.type}, timeline: ${lead.timeline}.` +
          (lead.message ? ` Their note: "${lead.message.slice(0, 160)}"` : ""),
      };
    case "checkin_sms":
      return {
        body:
          `Hi ${name}, ${agent} here — just checking in on ${askVerb}${propClause}. ` +
          `Happy to answer any questions whenever you're ready.`,
      };
    case "value_email":
      return {
        subject: `A quick update on ${askVerb}`,
        body:
          `Hi ${name},\n\n` +
          `Wanted to share something useful as you think about ${askVerb}` +
          `${propClause ? ` and ${prop}` : ""}. ` +
          `Markets move fast right now, so if you'd like a tailored rundown just reply and I'll put one together` +
          (book ? `, or book a time here: ${book}` : ".") +
          `\n\nBest,\n${agent}`,
      };
    case "breakup_call":
      return {
        body:
          `Final call attempt for ${name}${lead.phone ? ` at ${lead.phone}` : ""}. ` +
          `If no answer, move to long-term nurture.`,
      };
    case "breakup_email":
      return {
        subject: `Should I close your file?`,
        body:
          `Hi ${name},\n\n` +
          `I don't want to crowd your inbox, so this is my last note for now. ` +
          `If ${askVerb} is still on your mind, just reply "yes" and I'll jump right back in. ` +
          `Otherwise I'll check in down the road.\n\nAll the best,\n${agent}`,
      };
    default:
      return { body: `Hi ${name}, ${agent} here — following up on ${askVerb}.` };
  }
}

// Pick an available channel. If the lead can't be reached on a channel,
// substitute one they can — keeping the touch count intact.
function resolveChannel(channel: Channel, lead: Lead): Channel {
  if (channel === "sms" && !lead.phone) return lead.email ? "email" : "call";
  if (channel === "email" && !lead.email) return lead.phone ? "sms" : "call";
  return channel;
}

// ── Business-hours clamp (timezone-aware, no external deps) ──────────────
function hourInTz(date: Date, tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(date),
    10
  );
}

function clampToBusinessHours(date: Date, tz: string): Date {
  // SMS/calls only between 08:00 and 21:00 local. Shift earlier-than-8 up to
  // 8am same day; 21:00-or-later to 8am next day.
  let d = date;
  for (let guard = 0; guard < 3; guard++) {
    const h = hourInTz(d, tz);
    if (h >= 8 && h < 21) return d;
    if (h < 8) {
      d = new Date(d.getTime() + (8 - h) * 60 * 60 * 1000);
    } else {
      d = new Date(d.getTime() + (24 - h + 8) * 60 * 60 * 1000);
    }
  }
  return d;
}

export function buildCadence(
  lead: Lead,
  score: ScoreResult,
  ctx: CadenceContext
): CadenceResult {
  const count = COUNT_BY_PRIORITY[score.priority];
  const base = new Date(lead.receivedAt).getTime();
  const start = Number.isFinite(base) ? base : Date.now();

  const touches: Touch[] = [];
  let maxOffset = 0;

  MASTER_PLAN.slice(0, count).forEach((step, i) => {
    const channel = resolveChannel(step.channel, lead);
    let when = new Date(start + step.offsetMinutes * 60 * 1000);
    if (channel === "sms" || channel === "call") {
      when = clampToBusinessHours(when, ctx.timezone);
    }
    // Step 1 is the instant response; never clamp it.
    if (i === 0) when = new Date(start);

    const tmpl = renderTemplate(step.templateKey, lead, ctx);
    touches.push({
      step: i + 1,
      channel,
      offsetMinutes: step.offsetMinutes,
      scheduledAt: when.toISOString(),
      subject: tmpl.subject,
      body: tmpl.body,
      purpose: step.purpose,
    });
    maxOffset = Math.max(maxOffset, step.offsetMinutes);
  });

  return {
    touches,
    summary: {
      total: touches.length,
      bySms: touches.filter((t) => t.channel === "sms").length,
      byEmail: touches.filter((t) => t.channel === "email").length,
      byCall: touches.filter((t) => t.channel === "call").length,
      spanDays: Math.round(maxOffset / DAY),
      firstTouchChannel: touches[0]?.channel ?? "email",
    },
  };
}
