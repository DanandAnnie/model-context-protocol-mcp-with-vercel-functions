// ============================================================
// Speed-to-Lead — GHL write actions (LeadConnector API v2)
//
// These are the ONLY write paths to GHL in this project; ghl-api.ts stays
// read-only by design. Every helper is gated on credentials and returns a
// structured ActionResult instead of throwing, so the orchestrator can
// record a per-step audit trail and degrade gracefully when a sub-account
// isn't fully wired up.
// ============================================================

import { ghlFetch, GHL_LOC } from "./ghl-api.js";

export interface ActionResult {
  action: string;
  status: "executed" | "skipped" | "error" | "planned";
  detail?: string;
  data?: unknown;
}

export function ghlConfigured(): boolean {
  return Boolean(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID);
}

function skip(action: string, detail: string): ActionResult {
  return { action, status: "skipped", detail };
}

async function run(
  action: string,
  fn: () => Promise<unknown>
): Promise<ActionResult> {
  if (!ghlConfigured()) {
    return skip(action, "GHL_API_KEY / GHL_LOCATION_ID not configured");
  }
  try {
    const data = await fn();
    return { action, status: "executed", data };
  } catch (e) {
    return { action, status: "error", detail: (e as Error).message };
  }
}

export interface UpsertContactInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  source?: string;
  tags?: string[];
}

export async function upsertContact(
  input: UpsertContactInput
): Promise<ActionResult> {
  return run("upsert_contact", () =>
    ghlFetch("/contacts/upsert", {
      method: "POST",
      body: {
        locationId: GHL_LOC,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        source: input.source,
        tags: input.tags,
      },
    })
  );
}

export async function addContactTags(
  contactId: string,
  tags: string[]
): Promise<ActionResult> {
  return run("add_tags", () =>
    ghlFetch(`/contacts/${contactId}/tags`, {
      method: "POST",
      body: { tags },
    })
  );
}

export interface CreateOpportunityInput {
  contactId: string;
  name: string;
  pipelineId?: string;
  stageId?: string;
}

export async function createOpportunity(
  input: CreateOpportunityInput
): Promise<ActionResult> {
  if (!input.pipelineId || !input.stageId) {
    return skip(
      "create_opportunity",
      "no GHL pipeline/stage id mapped (set GHL_PIPELINE_MAP)"
    );
  }
  return run("create_opportunity", () =>
    ghlFetch("/opportunities/", {
      method: "POST",
      body: {
        locationId: GHL_LOC,
        pipelineId: input.pipelineId,
        pipelineStageId: input.stageId,
        contactId: input.contactId,
        name: input.name,
        status: "open",
      },
    })
  );
}

export async function sendMessage(
  contactId: string,
  channel: "sms" | "email",
  body: string,
  subject?: string
): Promise<ActionResult> {
  const action = `send_${channel}`;
  const payload: Record<string, unknown> =
    channel === "email"
      ? { type: "Email", contactId, subject: subject ?? "Following up", html: body, message: body }
      : { type: "SMS", contactId, message: body };
  return run(action, () =>
    ghlFetch("/conversations/messages", { method: "POST", body: payload })
  );
}

export async function createTask(
  contactId: string,
  title: string,
  body: string,
  dueDate: string
): Promise<ActionResult> {
  return run("create_call_task", () =>
    ghlFetch(`/contacts/${contactId}/tasks`, {
      method: "POST",
      body: { title, body, dueDate, completed: false },
    })
  );
}

/** Best-effort extraction of a contact id from an upsert response envelope. */
export function extractContactId(data: unknown): string | undefined {
  const d = data as Record<string, any> | undefined;
  return (
    d?.contact?.id ??
    d?.contact?._id ??
    d?.id ??
    d?._id ??
    undefined
  );
}
