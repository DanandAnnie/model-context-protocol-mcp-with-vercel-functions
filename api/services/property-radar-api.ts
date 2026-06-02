// ============================================================
// PropertyRadar API Service
// Official API: https://developers.propertyradar.com/api
//
// Core pattern:
//   - Search: POST /v1/properties with { Criteria, Fields, Limit }
//     Criteria is an array of { name, value: [...] } objects where `name` is
//     one of PropertyRadar's filter IDs (State, City, ZipFive, County, APN,
//     Address, SiteAddress, RadarID, …).
//   - Single property: GET /v1/properties/{RadarID}
//   - Sub-resources:
//       GET /v1/properties/{RadarID}/comps/sales
//       GET /v1/properties/{RadarID}/transactions
//
// `Fields` controls the returned field set. `Overview` covers the basics
// (address, owner, value). `PropertyTab` is a richer bundle that includes
// mortgage/loan and foreclosure signals.
// ============================================================

import type { PropertySearchFilters } from "../types/property.js";

const PR_API_BASE = "https://api.propertyradar.com/v1";

export type Criterion = { name: string; value: Array<string | number> };

function getApiToken(): string {
  const token = process.env.PROPERTY_RADAR_API_TOKEN;
  if (!token) {
    throw new Error(
      "PROPERTY_RADAR_API_TOKEN environment variable is required. " +
        "Get your API token from PropertyRadar: https://app.propertyradar.com/settings/api"
    );
  }
  return token;
}

async function prRequest(
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}
): Promise<any> {
  const token = getApiToken();
  const url = new URL(`${PR_API_BASE}${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`PropertyRadar API error ${response.status}: ${errorBody}`);
  }
  return response.json();
}

// ── Criteria builder ─────────────────────────────────────────
// Maps our PropertySearchFilters shape onto PropertyRadar's Criteria names.
// Names marked "documented" come from the official API docs. Names marked
// "best-effort" follow PR's usual CamelCase convention but should be
// verified when the tool is exercised with real credentials — if PR returns
// an "unknown criterion" error, tweak the name here.
function buildCriteria(filters: PropertySearchFilters): Criterion[] {
  const c: Criterion[] = [];
  const pushStr = (name: string, v?: string) => { if (v) c.push({ name, value: [v] }); };
  const pushNum = (name: string, v?: number) => { if (v !== undefined) c.push({ name, value: [v] }); };
  const pushRange = (name: string, min?: number, max?: number) => {
    if (min !== undefined || max !== undefined) {
      c.push({ name, value: [min ?? "", max ?? ""].map(String) });
    }
  };
  const pushBool = (name: string, v?: boolean) => {
    if (v !== undefined) c.push({ name, value: [v ? 1 : 0] });
  };

  // documented
  pushStr("State", filters.state);
  pushStr("City", filters.city);
  pushStr("ZipFive", filters.zip);
  pushStr("County", filters.county);
  pushStr("APN", filters.apn);
  pushStr("Address", filters.address);
  if (filters.propertyType?.length) {
    c.push({ name: "PropertyType", value: filters.propertyType });
  }
  if (filters.ownerName) {
    c.push({ name: "OwnerFirstName", value: [filters.ownerName] });
  }

  // best-effort (PR's typical CamelCase; adjust if API rejects)
  pushRange("Beds", filters.bedroomsMin, filters.bedroomsMax);
  pushRange("Baths", filters.bathroomsMin, filters.bathroomsMax);
  pushRange("SquareFeet", filters.sqftMin, filters.sqftMax);
  pushRange("LotSize", filters.lotSizeMin, filters.lotSizeMax);
  pushRange("YearBuilt", filters.yearBuiltMin, filters.yearBuiltMax);
  pushRange("AVMValue", filters.valueMin, filters.valueMax);
  pushRange("AvailableEquity", filters.equityMin, filters.equityMax);
  pushRange("EquityPercent", filters.equityPercentMin, filters.equityPercentMax);
  pushRange("LengthOfOwnership", filters.lengthOfOwnershipMin, filters.lengthOfOwnershipMax);

  pushBool("OwnerOccupied", filters.ownerOccupied);
  pushBool("AbsenteeOwner", filters.absenteeOwner);
  pushBool("CorporateOwned", filters.corporateOwned);
  pushBool("TrustOwned", filters.trustOwned);
  pushBool("OutOfStateOwner", filters.outOfStateOwner);
  pushBool("HasMultipleMortgages", filters.hasMultipleMortgages);
  pushBool("AdjustableRate", filters.armLoan);
  pushBool("FreeAndClear", filters.freeClear);
  pushBool("HighEquity", filters.highEquity);
  pushBool("PreForeclosure", filters.preForeclosure);
  pushBool("Auction", filters.auction);
  pushBool("BankOwned", filters.bankOwned);
  pushBool("TaxDelinquent", filters.taxDelinquent);
  pushBool("ListedForSale", filters.listedForSale);
  pushBool("RecentlySold", filters.recentlySold);
  pushBool("CashBuyer", filters.cashBuyer);
  pushBool("Pool", filters.pool);

  pushStr("LoanType", filters.loanType);
  pushNum("Stories", filters.stories);
  pushNum("SoldWithinMonths", filters.soldWithinMonths);

  return c;
}

// ── Property Search ──────────────────────────────────────────
export async function searchProperties(
  filters: PropertySearchFilters,
  opts: { fields?: string[]; limit?: number } = {}
): Promise<any> {
  const limit = opts.limit ?? filters.limit ?? 25;
  const page = filters.page && filters.page > 1 ? filters.page : 1;
  const body: Record<string, unknown> = {
    Criteria: buildCriteria(filters),
    Fields: opts.fields ?? ["Overview"],
    Limit: limit,
  };
  if (page > 1) body.Start = (page - 1) * limit;
  return prRequest("POST", "/properties", { body });
}

// ── Single Property ──────────────────────────────────────────
export async function getPropertyDetails(radarId: string): Promise<any> {
  return prRequest("GET", `/properties/${encodeURIComponent(radarId)}`);
}

// ── Property by Street Address ───────────────────────────────
// Does a Criteria search (Address + City + State) and returns the first hit.
export async function getPropertyByAddress(
  address: string,
  city: string,
  state: string
): Promise<any> {
  const result = await prRequest("POST", "/properties", {
    body: {
      Criteria: [
        { name: "Address", value: [address] },
        { name: "City", value: [city] },
        { name: "State", value: [state] },
      ],
      Fields: ["Overview"],
      Limit: 1,
    },
  });
  // PR wraps results in various envelope shapes across endpoints; return the
  // first record if we can find one, otherwise the raw response so callers
  // can inspect the envelope.
  const first =
    result?.results?.[0] ??
    result?.items?.[0] ??
    result?.data?.[0] ??
    (Array.isArray(result) ? result[0] : undefined);
  return first ?? result;
}

// ── Owner info ───────────────────────────────────────────────
// Owner is included in the `Overview` Fields bundle on a property lookup.
export async function getOwnerInfo(radarId: string): Promise<any> {
  return getPropertyDetails(radarId);
}

// ── Mortgage / Loan data ─────────────────────────────────────
// Mortgage signals come back via the `PropertyTab` Fields bundle.
export async function getMortgageData(radarId: string): Promise<any> {
  return prRequest("POST", "/properties", {
    body: {
      Criteria: [{ name: "RadarID", value: [radarId] }],
      Fields: ["PropertyTab"],
      Limit: 1,
    },
  });
}

// ── Foreclosure data ─────────────────────────────────────────
export async function getForeclosureData(radarId: string): Promise<any> {
  return prRequest("POST", "/properties", {
    body: {
      Criteria: [{ name: "RadarID", value: [radarId] }],
      Fields: ["PropertyTab"],
      Limit: 1,
    },
  });
}

// ── Transfer / Transaction history ───────────────────────────
// PR's endpoint is /transactions (NOT /transfers).
export async function getTransferHistory(radarId: string): Promise<any> {
  return prRequest("GET", `/properties/${encodeURIComponent(radarId)}/transactions`);
}

// ── Comparable Sales ─────────────────────────────────────────
export async function getComparableSales(
  radarId: string,
  radius: number = 1,
  months: number = 6
): Promise<any> {
  return prRequest(
    "GET",
    `/properties/${encodeURIComponent(radarId)}/comps/sales`,
    { query: { radius, months } }
  );
}

// ── Lists ────────────────────────────────────────────────────
// Persons/Lists endpoints — exact request shape isn't fully specified in the
// public docs section we relied on. Best-effort POST /lists with a Criteria
// array; tweak here if PR returns a schema mismatch.
export async function createPropertyList(
  name: string,
  filters: PropertySearchFilters
): Promise<any> {
  return prRequest("POST", "/lists", {
    body: {
      Name: name,
      Criteria: buildCriteria(filters),
    },
  });
}

export async function getPropertyLists(): Promise<any> {
  return prRequest("GET", "/lists");
}
