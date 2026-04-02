// ============================================================
// PropertyRadar API Service
// Official API integration: https://api.propertyradar.com
// Requires a PropertyRadar subscription with API access
// ============================================================

import type {
  PropertyDetails,
  PropertySearchFilters,
  OwnerInfo,
  MortgageInfo,
  TransferRecord,
  ForeclosureInfo,
} from "../types/property.js";

const PR_API_BASE = "https://api.propertyradar.com/v1";

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

async function prFetch(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<any> {
  const token = getApiToken();
  const url = new URL(`${PR_API_BASE}${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `PropertyRadar API error ${response.status}: ${errorBody}`
    );
  }

  return response.json();
}

// ── Property Search ──────────────────────────────────────────
export async function searchProperties(
  filters: PropertySearchFilters
): Promise<any> {
  const params: Record<string, any> = {};

  if (filters.address) params.address = filters.address;
  if (filters.city) params.city = filters.city;
  if (filters.state) params.state = filters.state;
  if (filters.zip) params.zip = filters.zip;
  if (filters.county) params.county = filters.county;
  if (filters.apn) params.apn = filters.apn;
  if (filters.propertyType) params.property_type = filters.propertyType.join(",");
  if (filters.bedroomsMin) params.bedrooms_min = filters.bedroomsMin;
  if (filters.bedroomsMax) params.bedrooms_max = filters.bedroomsMax;
  if (filters.bathroomsMin) params.bathrooms_min = filters.bathroomsMin;
  if (filters.bathroomsMax) params.bathrooms_max = filters.bathroomsMax;
  if (filters.sqftMin) params.sqft_min = filters.sqftMin;
  if (filters.sqftMax) params.sqft_max = filters.sqftMax;
  if (filters.valueMin) params.value_min = filters.valueMin;
  if (filters.valueMax) params.value_max = filters.valueMax;
  if (filters.ownerOccupied !== undefined) params.owner_occupied = filters.ownerOccupied;
  if (filters.preForeclosure) params.pre_foreclosure = true;
  if (filters.taxDelinquent) params.tax_delinquent = true;
  if (filters.freeClear) params.free_clear = true;
  if (filters.page) params.page = filters.page;
  if (filters.limit) params.limit = filters.limit;
  if (filters.sortBy) params.sort_by = filters.sortBy;

  return prFetch("/properties", params);
}

// ── Property Details ─────────────────────────────────────────
export async function getPropertyDetails(
  propertyId: string
): Promise<any> {
  return prFetch(`/properties/${propertyId}`);
}

// ── Property by Address ──────────────────────────────────────
export async function getPropertyByAddress(
  address: string,
  city: string,
  state: string
): Promise<any> {
  return prFetch("/properties/search", { address, city, state });
}

// ── Owner Info ───────────────────────────────────────────────
export async function getOwnerInfo(propertyId: string): Promise<any> {
  return prFetch(`/properties/${propertyId}/owner`);
}

// ── Mortgage Data ────────────────────────────────────────────
export async function getMortgageData(propertyId: string): Promise<any> {
  return prFetch(`/properties/${propertyId}/mortgages`);
}

// ── Transfer History ─────────────────────────────────────────
export async function getTransferHistory(
  propertyId: string
): Promise<any> {
  return prFetch(`/properties/${propertyId}/transfers`);
}

// ── Foreclosure Data ─────────────────────────────────────────
export async function getForeclosureData(
  propertyId: string
): Promise<any> {
  return prFetch(`/properties/${propertyId}/foreclosure`);
}

// ── Comparable Sales ─────────────────────────────────────────
export async function getComparableSales(
  propertyId: string,
  radius: number = 1,
  months: number = 6
): Promise<any> {
  return prFetch(`/properties/${propertyId}/comps`, { radius, months });
}

// ── Lists ────────────────────────────────────────────────────
export async function createPropertyList(
  name: string,
  filters: PropertySearchFilters
): Promise<any> {
  const token = getApiToken();
  const response = await fetch(`${PR_API_BASE}/lists`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ name, criteria: filters }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `PropertyRadar API error ${response.status}: ${errorBody}`
    );
  }

  return response.json();
}

export async function getPropertyLists(): Promise<any> {
  return prFetch("/lists");
}
