// ============================================================
// Speed-to-Lead — canonical lead model + multi-source normalizer
//
// Leads arrive from many shapes: website contact forms, portal
// emails/webhooks (Zillow, Realtor.com, Redfin), paid social lead
// ads (Facebook/Instagram/Google), and social DMs. This module maps
// any of those raw payloads onto one canonical `Lead` so the scoring,
// routing, and cadence stages downstream never have to care where a
// lead came from.
// ============================================================

export type LeadSource =
  | "website"
  | "zillow"
  | "realtor"
  | "redfin"
  | "facebook_ad"
  | "google_ad"
  | "instagram_dm"
  | "facebook_dm"
  | "referral"
  | "manual"
  | "unknown";

export type LeadType = "buyer" | "seller" | "investor" | "renter" | "unknown";

export type Timeline =
  | "immediate"
  | "1-3_months"
  | "3-6_months"
  | "6-12_months"
  | "just_browsing"
  | "unknown";

export interface Lead {
  source: LeadSource;
  type: LeadType;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  /** Free-text inquiry, form comments, or DM body. */
  message?: string;
  /** Property of interest (buyer) or the lead's own home (seller). */
  propertyAddress?: string;
  propertyValue?: number;
  budgetMin?: number;
  budgetMax?: number;
  timeline: Timeline;
  preApproved?: boolean;
  city?: string;
  state?: string;
  zip?: string;
  /** ISO timestamp the lead entered the system. */
  receivedAt: string;
  /** Original untouched payload, kept for auditing. */
  raw?: Record<string, unknown>;
}

const SOURCE_ALIASES: Record<string, LeadSource> = {
  website: "website",
  web: "website",
  site: "website",
  form: "website",
  contact_form: "website",
  zillow: "zillow",
  trulia: "zillow",
  realtor: "realtor",
  "realtor.com": "realtor",
  redfin: "redfin",
  facebook_ad: "facebook_ad",
  fb_ad: "facebook_ad",
  facebook_lead_ad: "facebook_ad",
  meta_ad: "facebook_ad",
  google_ad: "google_ad",
  google: "google_ad",
  adwords: "google_ad",
  instagram: "instagram_dm",
  instagram_dm: "instagram_dm",
  ig_dm: "instagram_dm",
  ig: "instagram_dm",
  facebook_dm: "facebook_dm",
  fb_dm: "facebook_dm",
  messenger: "facebook_dm",
  referral: "referral",
  manual: "manual",
};

function str(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : undefined;
  }
  if (typeof v === "number") return String(v);
  return undefined;
}

function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(obj[k]);
    if (v) return v;
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[$,\s]/g, "");
    const n = Number(cleaned);
    if (Number.isFinite(n) && cleaned !== "") return n;
  }
  return undefined;
}

function normalizePhone(raw?: string): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 7) return raw.trim();
  return undefined;
}

function splitName(full?: string): { firstName?: string; lastName?: string } {
  if (!full) return {};
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function normalizeSource(raw?: string): LeadSource {
  if (!raw) return "unknown";
  const key = raw.trim().toLowerCase().replace(/\s+/g, "_");
  return SOURCE_ALIASES[key] ?? "unknown";
}

const SELLER_RE =
  /\b(sell|selling|list(ing)?|what'?s my home worth|home value|cma|valuation|cash offer|downsiz)/i;
const BUYER_RE =
  /\b(buy|buying|purchase|looking for|tour|showing|see (the|this) (home|house|property)|pre-?approv|mortgage)/i;
const RENTER_RE = /\b(rent|renting|lease|tenant|apartment)\b/i;
const INVESTOR_RE = /\b(invest|investor|rental property|cash flow|cap rate|flip|portfolio|1031)\b/i;

export function inferType(message?: string, hint?: string): LeadType {
  const h = (hint ?? "").toLowerCase();
  if (h === "buyer" || h === "seller" || h === "investor" || h === "renter") {
    return h as LeadType;
  }
  const text = message ?? "";
  if (!text) return "unknown";
  // Investor and renter signals are more specific, check them first.
  if (INVESTOR_RE.test(text)) return "investor";
  if (RENTER_RE.test(text)) return "renter";
  if (SELLER_RE.test(text)) return "seller";
  if (BUYER_RE.test(text)) return "buyer";
  return "unknown";
}

export function inferTimeline(message?: string, explicit?: string): Timeline {
  const e = (explicit ?? "").toLowerCase().replace(/\s+/g, "_");
  const known: Timeline[] = [
    "immediate",
    "1-3_months",
    "3-6_months",
    "6-12_months",
    "just_browsing",
  ];
  for (const k of known) {
    if (e.includes(k.replace(/_/g, ""))) return k;
  }
  const text = (message ?? "").toLowerCase();
  if (!text) return "unknown";
  if (/\b(asap|immediately|right away|this week|urgent|today|now)\b/.test(text)) {
    return "immediate";
  }
  if (/\b(next month|30 days|few weeks|1-3 months|soon)\b/.test(text)) return "1-3_months";
  if (/\b(this summer|few months|3-6 months)\b/.test(text)) return "3-6_months";
  if (/\b(next year|6-12 months|end of year)\b/.test(text)) return "6-12_months";
  if (/\b(just (looking|browsing)|curious|someday|no rush)\b/.test(text)) {
    return "just_browsing";
  }
  return "unknown";
}

function inferPreApproved(obj: Record<string, unknown>, message?: string): boolean | undefined {
  const explicit = obj["preApproved"] ?? obj["pre_approved"] ?? obj["preapproved"];
  if (typeof explicit === "boolean") return explicit;
  if (typeof explicit === "string") {
    if (/^(true|yes|y|1)$/i.test(explicit)) return true;
    if (/^(false|no|n|0)$/i.test(explicit)) return false;
  }
  if (message && /\bpre-?approv/i.test(message)) return true;
  return undefined;
}

/**
 * Map an arbitrary inbound payload onto the canonical Lead shape.
 * `sourceHint` (e.g. from a `?source=zillow` query param) wins over any
 * source field found inside the body.
 */
export function normalizeLead(
  raw: Record<string, unknown>,
  sourceHint?: string
): Lead {
  const obj = raw ?? {};

  const explicitName = pick(obj, ["name", "full_name", "fullName", "contact_name"]);
  const split = splitName(explicitName);
  const firstName =
    pick(obj, ["firstName", "first_name", "fname", "given_name"]) ?? split.firstName;
  const lastName =
    pick(obj, ["lastName", "last_name", "lname", "family_name", "surname"]) ?? split.lastName;

  const email = pick(obj, ["email", "Email", "email_address", "emailAddress"]);
  const phone = normalizePhone(
    pick(obj, ["phone", "Phone", "phone_number", "phoneNumber", "mobile", "tel"])
  );

  const message = pick(obj, [
    "message",
    "Message",
    "comments",
    "comment",
    "inquiry",
    "text",
    "body",
    "notes",
    "question",
    "description",
  ]);

  const propertyAddress = pick(obj, [
    "propertyAddress",
    "property_address",
    "address",
    "property",
    "listingAddress",
    "listing_address",
    "streetAddress",
  ]);

  const source = normalizeSource(sourceHint ?? str(obj["source"]) ?? str(obj["lead_source"]));
  const type = inferType(message, str(obj["type"]) ?? str(obj["leadType"]) ?? str(obj["lead_type"]));
  const timeline = inferTimeline(message, str(obj["timeline"]) ?? str(obj["timeframe"]));

  return {
    source,
    type,
    firstName,
    lastName,
    email,
    phone,
    message,
    propertyAddress,
    propertyValue: num(obj["propertyValue"] ?? obj["property_value"] ?? obj["price"]),
    budgetMin: num(obj["budgetMin"] ?? obj["budget_min"] ?? obj["priceMin"]),
    budgetMax: num(obj["budgetMax"] ?? obj["budget_max"] ?? obj["priceMax"] ?? obj["budget"]),
    timeline,
    preApproved: inferPreApproved(obj, message),
    city: pick(obj, ["city", "City"]),
    state: pick(obj, ["state", "State", "region"]),
    zip: pick(obj, ["zip", "Zip", "zipcode", "postal_code", "postalCode"]),
    receivedAt: str(obj["receivedAt"]) ?? new Date().toISOString(),
    raw: obj,
  };
}

export function leadFullName(lead: Lead): string {
  return [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || "there";
}
