// ============================================================
// Speed-to-Lead — intake orchestrator
//
// One entry point: take a raw inbound payload and run the whole pipeline —
// normalize → score → route → build cadence — then optionally execute the
// CRM side effects in GHL. Pure planning always runs; writes only happen
// when `execute` is set AND credentials exist. The immediate first response
// only sends when the autoresponder is explicitly enabled, so the webhook
// can never message a real lead by accident.
// ============================================================

import type { Lead } from "./lead-types.js";
import { normalizeLead, leadFullName } from "./lead-types.js";
import { scoreLead } from "./lead-scoring.js";
import type { ScoreResult } from "./lead-scoring.js";
import { routeLead } from "./lead-routing.js";
import type { RoutingResult } from "./lead-routing.js";
import { buildCadence } from "./follow-up-cadence.js";
import type { CadenceContext, CadenceResult, Touch } from "./follow-up-cadence.js";
import {
  ghlConfigured,
  upsertContact,
  addContactTags,
  createOpportunity,
  sendMessage,
  createTask,
  extractContactId,
} from "./ghl-actions.js";
import type { ActionResult } from "./ghl-actions.js";

export interface IntakeOptions {
  sourceHint?: string;
  /** Perform GHL writes (contact upsert, opportunity, tags, call tasks). */
  execute?: boolean;
  /** Force-send (or suppress) the immediate first response. Defaults to the
   *  LEAD_AUTORESPONDER env flag. */
  sendFirstResponse?: boolean;
  agent?: Partial<CadenceContext>;
}

export interface IntakeResult {
  lead: Lead;
  score: ScoreResult;
  routing: RoutingResult;
  cadence: CadenceResult;
  firstResponse: Touch;
  execution: {
    requested: boolean;
    ghlConfigured: boolean;
    contactId?: string;
    actions: ActionResult[];
  };
  slaFirstTouchSeconds: number;
}

function resolveAgentContext(override?: Partial<CadenceContext>): CadenceContext {
  return {
    agentName: override?.agentName ?? process.env.AGENT_NAME ?? "your agent",
    agentPhone: override?.agentPhone ?? process.env.AGENT_PHONE,
    bookingUrl: override?.bookingUrl ?? process.env.AGENT_CALENDAR_URL,
    timezone: override?.timezone ?? process.env.LEAD_TIMEZONE ?? "America/Denver",
  };
}

function autoresponderEnabled(): boolean {
  return /^(on|true|1|yes)$/i.test(process.env.LEAD_AUTORESPONDER ?? "");
}

export function planIntake(
  raw: Record<string, unknown>,
  options: IntakeOptions = {}
): Omit<IntakeResult, "execution"> {
  const lead = normalizeLead(raw, options.sourceHint);
  const score = scoreLead(lead);
  const routing = routeLead(lead, score);
  const cadence = buildCadence(lead, score, resolveAgentContext(options.agent));
  return {
    lead,
    score,
    routing,
    cadence,
    firstResponse: cadence.touches[0],
    slaFirstTouchSeconds: score.slaFirstTouchSeconds,
  };
}

export async function runLeadIntake(
  raw: Record<string, unknown>,
  options: IntakeOptions = {}
): Promise<IntakeResult> {
  const plan = planIntake(raw, options);
  const { lead, routing, cadence } = plan;

  const actions: ActionResult[] = [];
  let contactId: string | undefined;
  const configured = ghlConfigured();
  const shouldExecute = Boolean(options.execute) && configured;
  const shouldSend = options.sendFirstResponse ?? autoresponderEnabled();

  if (shouldExecute) {
    const oppName = `${leadFullName(lead)} — ${lead.type}`;

    const upsert = await upsertContact({
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      phone: lead.phone,
      source: lead.source,
      tags: routing.tags,
    });
    actions.push(upsert);
    if (upsert.status === "executed") contactId = extractContactId(upsert.data);

    if (contactId) {
      actions.push(await addContactTags(contactId, routing.tags));
      actions.push(
        await createOpportunity({
          contactId,
          name: oppName,
          pipelineId: routing.ghlPipelineId,
          stageId: routing.ghlStageId,
        })
      );

      // Immediate first response (only if autoresponder is on).
      const first = cadence.touches[0];
      if (first && (first.channel === "sms" || first.channel === "email")) {
        if (shouldSend) {
          actions.push(await sendMessage(contactId, first.channel, first.body, first.subject));
        } else {
          actions.push({
            action: `send_${first.channel}`,
            status: "planned",
            detail: "autoresponder off — first response drafted but not sent",
          });
        }
      }

      // Call touches become real GHL tasks with due dates. SMS/email beyond
      // the first touch are returned as a plan for a GHL workflow to drive.
      for (const t of cadence.touches) {
        if (t.channel === "call") {
          actions.push(
            await createTask(
              contactId,
              `Call attempt — step ${t.step}`,
              t.body,
              t.scheduledAt
            )
          );
        } else if (t.step > 1) {
          actions.push({
            action: `schedule_${t.channel}`,
            status: "planned",
            detail: `step ${t.step} scheduled for ${t.scheduledAt}`,
          });
        }
      }
    }
  } else {
    // No execution: surface the full plan as "planned" actions for visibility.
    if (options.execute && !configured) {
      actions.push({
        action: "ghl_sync",
        status: "skipped",
        detail: "execute requested but GHL_API_KEY / GHL_LOCATION_ID not configured",
      });
    }
    for (const t of cadence.touches) {
      actions.push({
        action: `${t.channel === "call" ? "call_task" : t.channel}`,
        status: "planned",
        detail: `step ${t.step} · ${t.scheduledAt}`,
      });
    }
  }

  return {
    ...plan,
    execution: {
      requested: Boolean(options.execute),
      ghlConfigured: configured,
      contactId,
      actions,
    },
  };
}
