// Mission Control status endpoint.
// Returns non-sensitive server metadata: name, version, tool count, env key presence.
// Secret values are NEVER included — only booleans indicating whether each key is set.

import { getAuthState } from "./services/auth.js";

const START_TIME = Date.now();

const TOOL_NAMES = [
  "property_lookup_by_address","property_lookup_by_apn","property_search","property_comps",
  "owner_lookup","owner_search","find_absentee_owners","find_corporate_owned","find_trust_owned","find_out_of_state_owners",
  "mortgage_details","find_high_equity_properties","find_free_and_clear","find_arm_loans",
  "foreclosure_details","find_preforeclosures","find_auction_properties","find_bank_owned","find_tax_delinquent",
  "transfer_history","find_recent_sales",
  "build_property_list","get_property_lists",
  "market_demographics","flood_zone_check","nearby_schools","geocode_address","county_assessor_lookup",
  "create_property_alert","check_alerts",
  "property_valuation","investment_analysis",
];

const ENV_KEYS = [
  "PROPERTY_RADAR_API_TOKEN",
  "RAPIDAPI_KEY",
  "ATTOM_API_KEY",
  "CENSUS_API_KEY",
  "HUD_API_KEY",
];

export default function handler(req: Request): Response {
  const env: Record<string, boolean> = {};
  for (const k of ENV_KEYS) env[k] = Boolean(process.env[k]);

  const auth = getAuthState(req);

  const body = {
    name: "property-data-mcp-server",
    description: "PropertyRadar-style property intelligence MCP server — paired with Rex via OpenClaw Mission Control.",
    version: "1.0.0",
    status: "online",
    runtime: "Vercel Functions",
    uptime: (Date.now() - START_TIME) / 1000,
    tools: TOOL_NAMES.length,
    env,
    mcpPath: "/mcp",
    auth,
    generatedAt: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
