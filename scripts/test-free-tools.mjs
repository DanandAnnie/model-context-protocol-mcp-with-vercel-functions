// ============================================================
// Test script for free public data tools (no API keys needed)
// Run: node scripts/test-free-tools.mjs <YOUR_DEPLOYMENT_URL>
// ============================================================

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const BASE_URL = process.argv[2] || "http://localhost:3000";

async function main() {
  const client = new Client({ name: "property-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`));
  await client.connect(transport);

  console.log("Connected to MCP server at", BASE_URL);

  // List all available tools
  const { tools } = await client.listTools();
  console.log(`\n${tools.length} tools available:`);
  tools.forEach((t) => console.log(`  - ${t.name}`));

  // Test 1: Geocode an address
  console.log("\n--- Test 1: Geocode Address ---");
  const geo = await client.callTool({
    name: "geocode_address",
    arguments: { address: "1600 Pennsylvania Ave NW, Washington, DC 20500" },
  });
  console.log(geo.content[0].text.substring(0, 300));

  // Test 2: Flood Zone Check
  console.log("\n--- Test 2: Flood Zone Check ---");
  const flood = await client.callTool({
    name: "flood_zone_check",
    arguments: { address: "123 Main St, Miami, FL" },
  });
  console.log(flood.content[0].text.substring(0, 300));

  // Test 3: Nearby Schools
  console.log("\n--- Test 3: Nearby Schools ---");
  const schools = await client.callTool({
    name: "nearby_schools",
    arguments: { address: "350 5th Ave, New York, NY 10118", radiusMiles: 1 },
  });
  console.log(schools.content[0].text.substring(0, 500));

  // Test 4: Market Demographics
  console.log("\n--- Test 4: Market Demographics ---");
  const demo = await client.callTool({
    name: "market_demographics",
    arguments: { state: "California", county: "Los Angeles" },
  });
  console.log(demo.content[0].text.substring(0, 500));

  // Test 5: County Assessor Lookup
  console.log("\n--- Test 5: County Assessor Lookup ---");
  const assessor = await client.callTool({
    name: "county_assessor_lookup",
    arguments: { county: "Los Angeles", state: "California", apn: "5432-001-001" },
  });
  console.log(assessor.content[0].text);

  // Test 6: Investment Analysis
  console.log("\n--- Test 6: Investment Analysis ---");
  const invest = await client.callTool({
    name: "investment_analysis",
    arguments: {
      address: "123 Main St",
      city: "Los Angeles",
      state: "CA",
      purchasePrice: 500000,
      monthlyRent: 3000,
      downPaymentPercent: 25,
      interestRate: 6.5,
    },
  });
  console.log(invest.content[0].text.substring(0, 800));

  // Test 7: Property Lookup (free data only, no PR API key)
  console.log("\n--- Test 7: Property Lookup (free sources) ---");
  const lookup = await client.callTool({
    name: "property_lookup_by_address",
    arguments: {
      address: "350 5th Ave",
      city: "New York",
      state: "NY",
      zip: "10118",
    },
  });
  console.log(lookup.content[0].text.substring(0, 800));

  console.log("\n✓ All free tool tests completed successfully!");
  await client.close();
}

main().catch((err) => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
