// ============================================================
// Speed-to-Lead — instant lead scoring
//
// Deterministic 0-100 score from the factors that actually predict
// conversion: how reachable the lead is, how strong the source is,
// how urgent their timeline is, whether they're financed, and how
// much intent their message carries. Pure function, no I/O.
// ============================================================

import type { Lead, LeadSource } from "./lead-types.js";

export type LeadGrade = "A" | "B" | "C" | "D";
export type LeadPriority = "hot" | "warm" | "cold";

export interface ScoreFactor {
  label: string;
  points: number;
  max: number;
  detail?: string;
}

export interface ScoreResult {
  score: number;
  grade: LeadGrade;
  priority: LeadPriority;
  factors: ScoreFactor[];
  /** Target time-to-first-touch in seconds. Always 60 — speed is the whole point. */
  slaFirstTouchSeconds: number;
}

// Source quality reflects historical close rates: referrals and direct
// website inquiries convert best; cold DMs convert worst.
const SOURCE_QUALITY: Record<LeadSource, number> = {
  referral: 20,
  website: 18,
  zillow: 15,
  realtor: 15,
  redfin: 14,
  google_ad: 12,
  facebook_ad: 10,
  instagram_dm: 7,
  facebook_dm: 7,
  manual: 12,
  unknown: 5,
};

const TIMELINE_POINTS: Record<Lead["timeline"], number> = {
  immediate: 25,
  "1-3_months": 20,
  "3-6_months": 12,
  "6-12_months": 6,
  just_browsing: 2,
  unknown: 8,
};

function gradeFor(score: number): LeadGrade {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

function priorityFor(score: number): LeadPriority {
  if (score >= 70) return "hot";
  if (score >= 45) return "warm";
  return "cold";
}

export function scoreLead(lead: Lead): ScoreResult {
  const factors: ScoreFactor[] = [];

  // 1. Reachability (max 25) — can we actually respond in 60 seconds?
  let reach = 0;
  const reachBits: string[] = [];
  if (lead.phone) {
    reach += 15;
    reachBits.push("phone");
  }
  if (lead.email) {
    reach += 10;
    reachBits.push("email");
  }
  factors.push({
    label: "Reachability",
    points: reach,
    max: 25,
    detail: reachBits.length ? reachBits.join(" + ") : "no contact method",
  });

  // 2. Source quality (max 20)
  factors.push({
    label: "Source quality",
    points: SOURCE_QUALITY[lead.source],
    max: 20,
    detail: lead.source,
  });

  // 3. Timeline / urgency (max 25)
  factors.push({
    label: "Timeline",
    points: TIMELINE_POINTS[lead.timeline],
    max: 25,
    detail: lead.timeline,
  });

  // 4. Financing readiness (max 15)
  let financing = 0;
  const financeBits: string[] = [];
  if (lead.preApproved === true) {
    financing += 10;
    financeBits.push("pre-approved");
  }
  if (lead.budgetMax || lead.budgetMin || lead.propertyValue) {
    financing += 5;
    financeBits.push("budget/value known");
  }
  factors.push({
    label: "Financing",
    points: financing,
    max: 15,
    detail: financeBits.join(", ") || "unknown",
  });

  // 5. Intent / engagement (max 15)
  let intent = 0;
  const intentBits: string[] = [];
  if (lead.type !== "unknown") {
    intent += 5;
    intentBits.push(`identified as ${lead.type}`);
  }
  if (lead.propertyAddress) {
    intent += 5;
    intentBits.push("specific property");
  }
  const msgLen = (lead.message ?? "").trim().length;
  if (msgLen >= 80) {
    intent += 5;
    intentBits.push("detailed message");
  } else if (msgLen >= 20) {
    intent += 3;
    intentBits.push("brief message");
  }
  factors.push({
    label: "Intent",
    points: intent,
    max: 15,
    detail: intentBits.join(", ") || "minimal signal",
  });

  const score = Math.max(
    0,
    Math.min(100, factors.reduce((sum, f) => sum + f.points, 0))
  );

  return {
    score,
    grade: gradeFor(score),
    priority: priorityFor(score),
    factors,
    slaFirstTouchSeconds: 60,
  };
}
