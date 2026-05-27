// ============================================================
// Speed-to-Lead — pipeline routing
//
// Turns a scored lead into a concrete CRM destination: which pipeline,
// which entry stage, which tags, and which agent queue. Logical pipeline
// names map onto real GHL pipeline/stage IDs via the GHL_PIPELINE_MAP
// env var (JSON), so the same code works across sub-accounts.
// ============================================================

import type { Lead, LeadType } from "./lead-types.js";
import type { ScoreResult } from "./lead-scoring.js";

export interface RoutingResult {
  pipeline: string;
  stage: string;
  tags: string[];
  /** Logical assignment queue derived from priority. */
  queue: "on-call" | "standard" | "nurture";
  /** Resolved GHL pipeline id, if GHL_PIPELINE_MAP provides one. */
  ghlPipelineId?: string;
  /** Resolved GHL stage id, if GHL_PIPELINE_MAP provides one. */
  ghlStageId?: string;
}

const PIPELINE_BY_TYPE: Record<LeadType, string> = {
  buyer: "Buyer Pipeline",
  seller: "Seller / Listing Pipeline",
  investor: "Investor Pipeline",
  renter: "Rental Pipeline",
  unknown: "General Lead Pipeline",
};

interface PipelineMapEntry {
  pipelineId?: string;
  stageId?: string;
}

// Optional override: map logical pipeline names → real GHL ids.
// Example value:
//   {"Buyer Pipeline":{"pipelineId":"abc","stageId":"def"}}
function loadPipelineMap(): Record<string, PipelineMapEntry> {
  const raw = process.env.GHL_PIPELINE_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    console.warn("[SPEED-TO-LEAD] GHL_PIPELINE_MAP is not valid JSON — ignoring");
    return {};
  }
}

export function routeLead(lead: Lead, score: ScoreResult): RoutingResult {
  const pipeline = PIPELINE_BY_TYPE[lead.type];
  const stage = "New Lead";

  const tags = [
    "speed-to-lead",
    `source:${lead.source}`,
    `type:${lead.type}`,
    `grade:${score.grade}`,
    `priority:${score.priority}`,
  ];
  if (lead.timeline !== "unknown") tags.push(`timeline:${lead.timeline}`);
  if (lead.preApproved) tags.push("pre-approved");

  const queue: RoutingResult["queue"] =
    score.priority === "hot" ? "on-call" : score.priority === "warm" ? "standard" : "nurture";

  const map = loadPipelineMap();
  const entry = map[pipeline] ?? {};

  return {
    pipeline,
    stage,
    tags,
    queue,
    ghlPipelineId: entry.pipelineId,
    ghlStageId: entry.stageId,
  };
}
