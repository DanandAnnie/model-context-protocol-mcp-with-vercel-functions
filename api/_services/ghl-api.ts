// Thin HTTP client for GHL API v2 (Red Rock Real Estate sub-account).
// All helpers are read-only by design — no POST/PUT/DELETE to GHL data.

const GHL_BASE = process.env.GHL_BASE_URL ?? "https://services.leadconnectorhq.com";
const GHL_KEY  = process.env.GHL_API_KEY ?? "";
export const GHL_LOC = process.env.GHL_LOCATION_ID ?? "";

const GHL_HEADERS = {
  Authorization: `Bearer ${GHL_KEY}`,
  Version: "2021-07-28",
  "Content-Type": "application/json",
};

export async function ghlFetch(
  path: string,
  opts: { method?: string; body?: unknown; queryParams?: Record<string, string> } = {}
): Promise<unknown> {
  const url = new URL(`${GHL_BASE}${path}`);
  if (opts.queryParams) {
    for (const [k, v] of Object.entries(opts.queryParams)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers: GHL_HEADERS,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return text; }
}
