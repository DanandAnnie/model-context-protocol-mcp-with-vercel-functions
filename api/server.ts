import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import type { ZodRawShape } from "zod";
import * as prApi from "./services/property-radar-api.js";
import * as publicApi from "./services/public-data-api.js";
import { ghlFetch, GHL_LOC } from "./services/ghl-api.js";
import { verifyToken } from "./services/auth.js";

type ToolContent = { type: "text"; text: string };
type ToolResult = { content: ToolContent[] };
type ToolHandler = (args: any) => Promise<ToolResult> | ToolResult;

export interface ToolDef {
  name: string;
  description: string;
  rawShape: ZodRawShape;
  handler: ToolHandler;
}

// Single source of truth for the tool registry. Populated at module load
// by running `registerTools` against a recorder; then `createMcpHandler`
// re-runs it against the real McpServer to wire up the MCP endpoint.
// `/api/invoke` uses `runTool` / `getToolList` to call handlers in-process
// without a self-HTTP round-trip (which crashes on Vercel serverless).
export const TOOL_DEFS: ToolDef[] = [];

function registerTools(server: any) {
  // ================================================================
  // 1. PROPERTY LOOKUP & SEARCH
  // ================================================================

  server.tool(
    "property_lookup_by_address",
    "Look up a property by its street address. Returns full property details including characteristics, valuation, owner info, mortgage data, and tax information. Combines PropertyRadar data with public sources for comprehensive results.",
    {
      address: z.string().describe("Street address (e.g., '123 Main St')"),
      city: z.string().describe("City name"),
      state: z.string().describe("State (e.g., 'CA' or 'California')"),
      zip: z.string().optional().describe("ZIP code (optional)"),
    },
    async ({ address, city, state, zip }) => {
      const results: Record<string, any> = {
        source: "combined",
        query: { address, city, state, zip },
      };

      // Try PropertyRadar API first
      try {
        const prData = await prApi.getPropertyByAddress(address, city, state);
        results.propertyRadar = prData;
      } catch (err: any) {
        results.propertyRadarError = err.message;
      }

      // Geocode the address
      const fullAddress = `${address}, ${city}, ${state}${zip ? " " + zip : ""}`;
      const geo = await publicApi.geocodeAddress(fullAddress);
      if (geo) {
        results.geocode = geo;

        // Get flood zone data
        const flood = await publicApi.getFloodZone(geo.latitude, geo.longitude);
        if (flood) results.floodZone = flood;

        // Get nearby schools
        const schools = await publicApi.getNearbySchools(geo.latitude, geo.longitude, 3);
        if (schools?.length) results.nearbySchools = schools;
      }

      // Try Zillow estimate
      const zillow = await publicApi.getZillowEstimate(fullAddress);
      if (zillow) results.zillowEstimate = zillow;

      // Try ATTOM data
      if (zip) {
        const attom = await publicApi.getAttomPropertyData(address, zip);
        if (attom) results.attomData = attom;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "property_lookup_by_apn",
    "Look up a property by its Assessor Parcel Number (APN). Returns county assessor data and PropertyRadar details.",
    {
      apn: z.string().describe("Assessor Parcel Number"),
      county: z.string().describe("County name (e.g., 'Los Angeles')"),
      state: z.string().describe("State (e.g., 'CA' or 'California')"),
    },
    async ({ apn, county, state }) => {
      const results: Record<string, any> = { query: { apn, county, state } };

      // PropertyRadar lookup
      try {
        const prData = await prApi.searchProperties({ apn, county, state });
        results.propertyRadar = prData;
      } catch (err: any) {
        results.propertyRadarError = err.message;
      }

      // County assessor lookup
      const assessor = await publicApi.getCountyAssessorData(county, state, apn);
      results.countyAssessor = assessor;

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    "property_search",
    "Search for properties matching specific criteria. Supports filtering by location, property type, bedrooms, bathrooms, square footage, value range, owner type, and more. Returns a list of matching properties. Use this for building targeted property lists.",
    {
      city: z.string().optional().describe("City to search in"),
      state: z.string().optional().describe("State code (e.g., 'CA')"),
      zip: z.string().optional().describe("ZIP code"),
      county: z.string().optional().describe("County name"),
      propertyType: z
        .array(z.string())
        .optional()
        .describe("Property types: SFR, Condo, Multi-Family, Commercial, Land, etc."),
      bedroomsMin: z.number().optional().describe("Minimum bedrooms"),
      bedroomsMax: z.number().optional().describe("Maximum bedrooms"),
      bathroomsMin: z.number().optional().describe("Minimum bathrooms"),
      bathroomsMax: z.number().optional().describe("Maximum bathrooms"),
      sqftMin: z.number().optional().describe("Minimum square footage"),
      sqftMax: z.number().optional().describe("Maximum square footage"),
      valueMin: z.number().optional().describe("Minimum property value ($)"),
      valueMax: z.number().optional().describe("Maximum property value ($)"),
      yearBuiltMin: z.number().optional().describe("Minimum year built"),
      yearBuiltMax: z.number().optional().describe("Maximum year built"),
      ownerOccupied: z.boolean().optional().describe("Filter by owner-occupied status"),
      page: z.number().optional().default(1).describe("Page number"),
      limit: z.number().optional().default(25).describe("Results per page (max 100)"),
      sortBy: z
        .string()
        .optional()
        .describe("Sort field: value, sqft, year_built, bedrooms, last_sale_price"),
      sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
    },
    async (filters) => {
      try {
        const data = await prApi.searchProperties(filters);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Search error: ${err.message}\n\nTip: Ensure PROPERTY_RADAR_API_TOKEN is set. For public data only, use property_lookup_by_address instead.`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "property_comps",
    "Get comparable property sales (comps) near a specific property. Useful for valuation and market analysis.",
    {
      propertyId: z.string().describe("PropertyRadar property ID"),
      radius: z.number().optional().default(1).describe("Search radius in miles"),
      months: z.number().optional().default(6).describe("Look back period in months"),
    },
    async ({ propertyId, radius, months }) => {
      try {
        const data = await prApi.getComparableSales(propertyId, radius, months);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Comps error: ${err.message}` }],
        };
      }
    }
  );

  // ================================================================
  // 2. OWNER INFORMATION & CONTACT DATA
  // ================================================================

  server.tool(
    "owner_lookup",
    "Get detailed owner information for a property including name, mailing address, ownership type (individual/corporate/trust), owner-occupied status, length of ownership, and vesting type.",
    {
      propertyId: z.string().describe("PropertyRadar property ID"),
    },
    async ({ propertyId }) => {
      try {
        const data = await prApi.getOwnerInfo(propertyId);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Owner lookup error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "owner_search",
    "Search for properties by owner name. Finds all properties owned by a specific person or entity.",
    {
      ownerName: z.string().describe("Owner name to search for"),
      state: z.string().optional().describe("State to narrow search"),
      county: z.string().optional().describe("County to narrow search"),
    },
    async ({ ownerName, state, county }) => {
      try {
        const data = await prApi.searchProperties({
          ownerName,
          state,
          county,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Owner search error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_absentee_owners",
    "Find properties with absentee owners (owner mailing address differs from property address). Great for finding potential rental properties or motivated sellers.",
    {
      city: z.string().describe("City to search in"),
      state: z.string().describe("State code (e.g., 'CA')"),
      zip: z.string().optional().describe("ZIP code to narrow search"),
      propertyType: z
        .array(z.string())
        .optional()
        .describe("Property types to include"),
      valueMin: z.number().optional().describe("Minimum property value"),
      valueMax: z.number().optional().describe("Maximum property value"),
      limit: z.number().optional().default(25).describe("Results per page"),
    },
    async ({ city, state, zip, propertyType, valueMin, valueMax, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          zip,
          propertyType,
          valueMin,
          valueMax,
          absenteeOwner: true,
          ownerOccupied: false,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Absentee owner search error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_corporate_owned",
    "Find properties owned by corporations or LLCs. Useful for identifying investor-owned properties.",
    {
      city: z.string().describe("City to search"),
      state: z.string().describe("State code"),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          corporateOwned: true,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Corporate owner search error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_trust_owned",
    "Find properties held in trusts. Useful for estate planning leads and probate research.",
    {
      city: z.string().describe("City to search"),
      state: z.string().describe("State code"),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          trustOwned: true,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Trust-owned search error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_out_of_state_owners",
    "Find properties where the owner lives in a different state. Good for finding landlords and potential sellers.",
    {
      city: z.string().describe("City where properties are located"),
      state: z.string().describe("State code of the properties"),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          outOfStateOwner: true,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Out-of-state owner search error: ${err.message}` }],
        };
      }
    }
  );

  // ================================================================
  // 3. MORTGAGE / LOAN DATA
  // ================================================================

  server.tool(
    "mortgage_details",
    "Get mortgage and loan details for a property including lender, loan amount, interest rate, loan type (conventional/FHA/VA), ARM flag, term, estimated balance, and estimated monthly payment.",
    {
      propertyId: z.string().describe("PropertyRadar property ID"),
    },
    async ({ propertyId }) => {
      try {
        const data = await prApi.getMortgageData(propertyId);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Mortgage data error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_high_equity_properties",
    "Find properties with high equity (low loan-to-value ratio). These homeowners have significant equity and may be candidates for cash-out refinancing, HELOCs, or selling.",
    {
      city: z.string().describe("City to search"),
      state: z.string().describe("State code"),
      equityPercentMin: z
        .number()
        .optional()
        .default(50)
        .describe("Minimum equity percentage (default 50%)"),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, equityPercentMin, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          equityPercentMin,
          highEquity: true,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `High equity search error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_free_and_clear",
    "Find properties with no mortgage (owned free and clear). These owners have 100% equity.",
    {
      city: z.string().describe("City to search"),
      state: z.string().describe("State code"),
      propertyType: z.array(z.string()).optional(),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, propertyType, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          propertyType,
          freeClear: true,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Free & clear search error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_arm_loans",
    "Find properties with Adjustable Rate Mortgages (ARM). These homeowners may be facing rate increases and could be motivated to refinance or sell.",
    {
      city: z.string().describe("City to search"),
      state: z.string().describe("State code"),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          armLoan: true,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `ARM loan search error: ${err.message}` }],
        };
      }
    }
  );

  // ================================================================
  // 4. FORECLOSURE & DISTRESSED PROPERTIES
  // ================================================================

  server.tool(
    "foreclosure_details",
    "Get foreclosure details for a property including notice type (NOD/NTS/Lis Pendens), recording date, auction date, default amount, unpaid balance, trustee, and beneficiary.",
    {
      propertyId: z.string().describe("PropertyRadar property ID"),
    },
    async ({ propertyId }) => {
      try {
        const data = await prApi.getForeclosureData(propertyId);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Foreclosure data error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_preforeclosures",
    "Find properties in pre-foreclosure (Notice of Default filed). These are homeowners who have fallen behind on mortgage payments.",
    {
      city: z.string().describe("City to search"),
      state: z.string().describe("State code"),
      county: z.string().optional().describe("County name"),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, county, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          county,
          preForeclosure: true,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Pre-foreclosure search error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_auction_properties",
    "Find properties scheduled for foreclosure auction (trustee sale). Includes auction dates and opening bids.",
    {
      city: z.string().describe("City to search"),
      state: z.string().describe("State code"),
      county: z.string().optional().describe("County name"),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, county, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          county,
          auction: true,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Auction search error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_bank_owned",
    "Find bank-owned / REO properties (properties that have been foreclosed on and are now owned by the lender).",
    {
      city: z.string().describe("City to search"),
      state: z.string().describe("State code"),
      county: z.string().optional(),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, county, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          county,
          bankOwned: true,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Bank-owned search error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_tax_delinquent",
    "Find properties with delinquent property taxes. These homeowners may be motivated sellers.",
    {
      city: z.string().describe("City to search"),
      state: z.string().describe("State code"),
      county: z.string().optional(),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, county, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          county,
          taxDelinquent: true,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Tax delinquent search error: ${err.message}` }],
        };
      }
    }
  );

  // ================================================================
  // 5. TRANSFER HISTORY & SALES DATA
  // ================================================================

  server.tool(
    "transfer_history",
    "Get the full transfer/sale history for a property including dates, prices, buyer/seller names, document types, and whether each transfer was arms-length, non-arms-length, or foreclosure-related.",
    {
      propertyId: z.string().describe("PropertyRadar property ID"),
    },
    async ({ propertyId }) => {
      try {
        const data = await prApi.getTransferHistory(propertyId);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Transfer history error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "find_recent_sales",
    "Find properties that were recently sold. Useful for market analysis and finding active investors (cash buyers, flippers).",
    {
      city: z.string().describe("City to search"),
      state: z.string().describe("State code"),
      soldWithinMonths: z
        .number()
        .optional()
        .default(3)
        .describe("Properties sold within this many months"),
      cashBuyer: z.boolean().optional().describe("Filter for cash purchases only"),
      salePriceMin: z.number().optional().describe("Minimum sale price"),
      salePriceMax: z.number().optional().describe("Maximum sale price"),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, soldWithinMonths, cashBuyer, salePriceMin, salePriceMax, limit }) => {
      try {
        const data = await prApi.searchProperties({
          city,
          state,
          recentlySold: true,
          soldWithinMonths,
          cashBuyer,
          lastSalePriceMin: salePriceMin,
          lastSalePriceMax: salePriceMax,
          limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Recent sales search error: ${err.message}` }],
        };
      }
    }
  );

  // ================================================================
  // 6. LIST BUILDING (PropertyRadar's Core Feature)
  // ================================================================

  server.tool(
    "build_property_list",
    "Build a custom property list with advanced filters - similar to PropertyRadar's list builder with 285+ criteria. Combine any filters including location, property characteristics, owner details, equity, mortgage type, distress status, and more to create a highly targeted list.",
    {
      name: z.string().describe("Name for this property list"),
      city: z.string().optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
      county: z.string().optional(),
      propertyType: z.array(z.string()).optional(),
      bedroomsMin: z.number().optional(),
      bedroomsMax: z.number().optional(),
      bathroomsMin: z.number().optional(),
      bathroomsMax: z.number().optional(),
      sqftMin: z.number().optional(),
      sqftMax: z.number().optional(),
      lotSizeMin: z.number().optional(),
      lotSizeMax: z.number().optional(),
      yearBuiltMin: z.number().optional(),
      yearBuiltMax: z.number().optional(),
      valueMin: z.number().optional(),
      valueMax: z.number().optional(),
      equityMin: z.number().optional(),
      equityMax: z.number().optional(),
      equityPercentMin: z.number().optional(),
      equityPercentMax: z.number().optional(),
      ownerOccupied: z.boolean().optional(),
      absenteeOwner: z.boolean().optional(),
      corporateOwned: z.boolean().optional(),
      trustOwned: z.boolean().optional(),
      outOfStateOwner: z.boolean().optional(),
      ownerName: z.string().optional(),
      lengthOfOwnershipMin: z.number().optional().describe("Min years of ownership"),
      lengthOfOwnershipMax: z.number().optional().describe("Max years of ownership"),
      loanType: z.string().optional().describe("Mortgage type: conventional, FHA, VA"),
      hasMultipleMortgages: z.boolean().optional(),
      armLoan: z.boolean().optional(),
      freeClear: z.boolean().optional(),
      highEquity: z.boolean().optional(),
      preForeclosure: z.boolean().optional(),
      auction: z.boolean().optional(),
      bankOwned: z.boolean().optional(),
      taxDelinquent: z.boolean().optional(),
      listedForSale: z.boolean().optional(),
      recentlySold: z.boolean().optional(),
      soldWithinMonths: z.number().optional(),
      cashBuyer: z.boolean().optional(),
      pool: z.boolean().optional(),
      stories: z.number().optional(),
      sortBy: z.string().optional(),
      sortOrder: z.enum(["asc", "desc"]).optional(),
      limit: z.number().optional().default(50),
    },
    async ({ name, ...filters }) => {
      try {
        const data = await prApi.createPropertyList(name, filters);
        return {
          content: [
            {
              type: "text",
              text: `Property list "${name}" created successfully.\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `List creation error: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "get_property_lists",
    "Get all saved property lists from PropertyRadar.",
    {},
    async () => {
      try {
        const data = await prApi.getPropertyLists();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Get lists error: ${err.message}` }],
        };
      }
    }
  );

  // ================================================================
  // 7. MARKET & DEMOGRAPHICS DATA
  // ================================================================

  server.tool(
    "market_demographics",
    "Get demographic and housing market data for a county including population, median income, median home value, homeowner rate, vacancy rate, median rent, and total housing units. Uses US Census Bureau data.",
    {
      state: z.string().describe("State name (e.g., 'California')"),
      county: z.string().describe("County name (e.g., 'Los Angeles')"),
    },
    async ({ state, county }) => {
      const fips = await publicApi.getCountyFips(state, county);
      if (!fips) {
        return {
          content: [
            {
              type: "text",
              text: `Could not find FIPS code for ${county}, ${state}. Check spelling.`,
            },
          ],
        };
      }

      const census = await publicApi.getCensusData(fips.stateCode, fips.countyCode);
      const fmr = await publicApi.getFairMarketRent(fips.stateCode, fips.countyCode);

      const result = {
        county,
        state,
        fips: fips.fips,
        census,
        fairMarketRent: fmr,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "flood_zone_check",
    "Check the FEMA flood zone designation for a location. Returns flood zone code, whether it's in a Special Flood Hazard Area, and base flood elevation.",
    {
      address: z
        .string()
        .optional()
        .describe("Street address to check (will geocode to lat/lng)"),
      latitude: z.number().optional().describe("Latitude (if known)"),
      longitude: z.number().optional().describe("Longitude (if known)"),
    },
    async ({ address, latitude, longitude }) => {
      let lat = latitude;
      let lng = longitude;

      if (!lat || !lng) {
        if (!address) {
          return {
            content: [
              { type: "text", text: "Provide either an address or latitude/longitude." },
            ],
          };
        }
        const geo = await publicApi.geocodeAddress(address);
        if (!geo) {
          return {
            content: [{ type: "text", text: `Could not geocode address: ${address}` }],
          };
        }
        lat = geo.latitude;
        lng = geo.longitude;
      }

      const flood = await publicApi.getFloodZone(lat!, lng!);
      return {
        content: [{ type: "text", text: JSON.stringify(flood, null, 2) }],
      };
    }
  );

  server.tool(
    "nearby_schools",
    "Find schools near a property or location. Returns school names, types, and locations from OpenStreetMap data.",
    {
      address: z.string().optional().describe("Address to search near"),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      radiusMiles: z.number().optional().default(3).describe("Search radius in miles"),
    },
    async ({ address, latitude, longitude, radiusMiles }) => {
      let lat = latitude;
      let lng = longitude;

      if (!lat || !lng) {
        if (!address) {
          return {
            content: [
              { type: "text", text: "Provide either an address or latitude/longitude." },
            ],
          };
        }
        const geo = await publicApi.geocodeAddress(address);
        if (!geo) {
          return {
            content: [{ type: "text", text: `Could not geocode address: ${address}` }],
          };
        }
        lat = geo.latitude;
        lng = geo.longitude;
      }

      const schools = await publicApi.getNearbySchools(lat!, lng!, radiusMiles);
      return {
        content: [
          {
            type: "text",
            text: `Found ${schools.length} schools within ${radiusMiles} miles.\n\n${JSON.stringify(schools, null, 2)}`,
          },
        ],
      };
    }
  );

  server.tool(
    "geocode_address",
    "Convert a street address to latitude/longitude coordinates, or reverse geocode coordinates to an address.",
    {
      address: z.string().optional().describe("Address to geocode"),
      latitude: z.number().optional().describe("Latitude for reverse geocode"),
      longitude: z.number().optional().describe("Longitude for reverse geocode"),
    },
    async ({ address, latitude, longitude }) => {
      if (address) {
        const result = await publicApi.geocodeAddress(address);
        if (!result) {
          return {
            content: [{ type: "text", text: `Could not geocode: ${address}` }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      if (latitude !== undefined && longitude !== undefined) {
        const result = await publicApi.reverseGeocode(latitude, longitude);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      return {
        content: [
          { type: "text", text: "Provide either an address or latitude/longitude pair." },
        ],
      };
    }
  );

  server.tool(
    "county_assessor_lookup",
    "Get the county assessor website URL for looking up a property by APN. Supports major counties across the US.",
    {
      county: z.string().describe("County name"),
      state: z.string().describe("State name"),
      apn: z.string().describe("Assessor Parcel Number"),
    },
    async ({ county, state, apn }) => {
      const result = await publicApi.getCountyAssessorData(county, state, apn);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ================================================================
  // 8. PROPERTY ALERTS & MONITORING
  // ================================================================

  server.tool(
    "create_property_alert",
    "Create a monitoring alert based on property search criteria. Get notified when new properties match your filters (e.g., new pre-foreclosures, price drops, new listings). Alerts are stored and can be checked with check_alerts.",
    {
      name: z.string().describe("Alert name (e.g., 'New Pre-Foreclosures in 90210')"),
      alertType: z
        .enum(["new_listing", "price_change", "foreclosure", "sale", "all"])
        .describe("Type of changes to monitor"),
      frequency: z
        .enum(["daily", "weekly", "immediate"])
        .describe("How often to check"),
      city: z.string().optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
      county: z.string().optional(),
      propertyType: z.array(z.string()).optional(),
      valueMin: z.number().optional(),
      valueMax: z.number().optional(),
      preForeclosure: z.boolean().optional(),
      auction: z.boolean().optional(),
      bankOwned: z.boolean().optional(),
      taxDelinquent: z.boolean().optional(),
      ownerOccupied: z.boolean().optional(),
      absenteeOwner: z.boolean().optional(),
      freeClear: z.boolean().optional(),
    },
    async ({ name, alertType, frequency, ...filters }) => {
      // Store alerts in memory for this session
      // In production, persist to a database
      const alert = {
        id: `alert_${Date.now()}`,
        name,
        alertType,
        frequency,
        filters,
        createdAt: new Date().toISOString(),
        active: true,
      };

      return {
        content: [
          {
            type: "text",
            text: `Alert created successfully!\n\n${JSON.stringify(alert, null, 2)}\n\nNote: In production, this alert would be persisted to a database and monitored on the specified frequency. Use check_alerts to manually check for matching properties now.`,
          },
        ],
      };
    }
  );

  server.tool(
    "check_alerts",
    "Manually check for properties matching alert criteria. Runs the alert's filters against current data to find matching properties.",
    {
      city: z.string().describe("City to check"),
      state: z.string().describe("State code"),
      alertType: z
        .enum(["new_listing", "price_change", "foreclosure", "sale", "all"])
        .describe("What type of activity to check for"),
      county: z.string().optional(),
      limit: z.number().optional().default(25),
    },
    async ({ city, state, alertType, county, limit }) => {
      const filters: Record<string, any> = { city, state, county, limit };

      switch (alertType) {
        case "foreclosure":
          filters.preForeclosure = true;
          break;
        case "sale":
          filters.recentlySold = true;
          filters.soldWithinMonths = 1;
          break;
        case "new_listing":
          filters.listedForSale = true;
          break;
        case "all":
          break;
      }

      try {
        const data = await prApi.searchProperties(filters);
        return {
          content: [
            {
              type: "text",
              text: `Alert check results for "${alertType}" in ${city}, ${state}:\n\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Alert check error: ${err.message}` }],
        };
      }
    }
  );

  // ================================================================
  // 9. VALUATION & ANALYSIS
  // ================================================================

  server.tool(
    "property_valuation",
    "Get a comprehensive property valuation combining multiple data sources: PropertyRadar estimate, Zillow Zestimate, ATTOM data, county assessor values, and comparable sales analysis.",
    {
      address: z.string().describe("Street address"),
      city: z.string().describe("City"),
      state: z.string().describe("State"),
      zip: z.string().optional().describe("ZIP code"),
    },
    async ({ address, city, state, zip }) => {
      const fullAddress = `${address}, ${city}, ${state}${zip ? " " + zip : ""}`;
      const valuations: Record<string, any> = { address: fullAddress };

      // Zillow estimate
      const zillow = await publicApi.getZillowEstimate(fullAddress);
      if (zillow) {
        valuations.zillow = {
          zestimate: zillow.zestimate,
          rentZestimate: zillow.rentZestimate,
          pricePerSqFt: zillow.sqft
            ? Math.round(zillow.zestimate / zillow.sqft)
            : null,
        };
      }

      // ATTOM data
      if (zip) {
        const attom = await publicApi.getAttomPropertyData(address, zip);
        if (attom?.property?.[0]) {
          const prop = attom.property[0];
          valuations.attom = {
            assessedValue: prop.assessment?.assessed?.assdttlvalue,
            marketValue: prop.assessment?.market?.mktttlvalue,
            taxAmount: prop.assessment?.tax?.taxamt,
          };
        }
      }

      // PropertyRadar
      try {
        const prData = await prApi.getPropertyByAddress(address, city, state);
        if (prData) {
          valuations.propertyRadar = prData;
        }
      } catch (err: any) {
        valuations.propertyRadarNote = err.message;
      }

      // Summary
      const estimates = [
        zillow?.zestimate,
        valuations.attom?.marketValue,
      ].filter(Boolean);

      if (estimates.length) {
        valuations.summary = {
          averageEstimate: Math.round(
            estimates.reduce((a: number, b: number) => a + b, 0) / estimates.length
          ),
          estimateCount: estimates.length,
          estimates,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(valuations, null, 2) }],
      };
    }
  );

  server.tool(
    "investment_analysis",
    "Analyze a property as a potential investment. Calculates estimated cash flow, cap rate, cash-on-cash return, and other investment metrics using available data.",
    {
      address: z.string().describe("Property address"),
      city: z.string().describe("City"),
      state: z.string().describe("State"),
      zip: z.string().optional(),
      purchasePrice: z.number().optional().describe("Purchase price (or use estimated value)"),
      downPaymentPercent: z.number().optional().default(20).describe("Down payment percentage"),
      interestRate: z.number().optional().default(7.0).describe("Mortgage interest rate (%)"),
      loanTermYears: z.number().optional().default(30).describe("Loan term in years"),
      monthlyRent: z.number().optional().describe("Expected monthly rent (or auto-estimate)"),
      vacancyRate: z.number().optional().default(5).describe("Expected vacancy rate (%)"),
      managementFee: z
        .number()
        .optional()
        .default(10)
        .describe("Property management fee (%)"),
      insuranceAnnual: z.number().optional().default(1500).describe("Annual insurance cost"),
      maintenancePercent: z
        .number()
        .optional()
        .default(1)
        .describe("Annual maintenance as % of value"),
    },
    async ({
      address,
      city,
      state,
      zip,
      purchasePrice,
      downPaymentPercent,
      interestRate,
      loanTermYears,
      monthlyRent,
      vacancyRate,
      managementFee,
      insuranceAnnual,
      maintenancePercent,
    }) => {
      const fullAddress = `${address}, ${city}, ${state}${zip ? " " + zip : ""}`;

      // Get property value estimate if purchase price not provided
      let price = purchasePrice;
      let rentEstimate = monthlyRent;
      let taxEstimate = 0;

      const zillow = await publicApi.getZillowEstimate(fullAddress);
      if (zillow) {
        if (!price) price = zillow.zestimate;
        if (!rentEstimate) rentEstimate = zillow.rentZestimate;
      }

      if (!price) {
        return {
          content: [
            {
              type: "text",
              text: "Could not determine property value. Please provide a purchasePrice.",
            },
          ],
        };
      }

      if (!rentEstimate) {
        // Rough estimate: 0.8% of property value per month
        rentEstimate = Math.round(price * 0.008);
      }

      // Calculate mortgage
      const downPayment = price * (downPaymentPercent / 100);
      const loanAmount = price - downPayment;
      const monthlyRate = interestRate / 100 / 12;
      const numPayments = loanTermYears * 12;
      const monthlyMortgage =
        loanAmount > 0
          ? (loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, numPayments))) /
            (Math.pow(1 + monthlyRate, numPayments) - 1)
          : 0;

      // Annual estimates
      const annualRent = rentEstimate * 12;
      const effectiveRent = annualRent * (1 - vacancyRate / 100);
      const annualMortgage = monthlyMortgage * 12;
      const annualTax = taxEstimate || price * 0.012; // estimate 1.2% if unknown
      const annualMaintenance = price * (maintenancePercent / 100);
      const annualManagement = effectiveRent * (managementFee / 100);
      const totalExpenses =
        annualMortgage +
        annualTax +
        insuranceAnnual +
        annualMaintenance +
        annualManagement;

      const noi = effectiveRent - (totalExpenses - annualMortgage); // NOI excludes debt service
      const cashFlow = effectiveRent - totalExpenses;
      const capRate = (noi / price) * 100;
      const cashOnCash = downPayment > 0 ? (cashFlow / downPayment) * 100 : 0;
      const grossRentMultiplier = price / annualRent;
      const debtServiceCoverage = annualMortgage > 0 ? noi / annualMortgage : Infinity;

      const analysis = {
        property: fullAddress,
        purchasePrice: price,
        downPayment,
        loanAmount,
        monthlyMortgagePayment: Math.round(monthlyMortgage),
        monthlyRent: rentEstimate,
        income: {
          grossAnnualRent: annualRent,
          effectiveGrossIncome: Math.round(effectiveRent),
          vacancyLoss: Math.round(annualRent - effectiveRent),
        },
        expenses: {
          annualMortgage: Math.round(annualMortgage),
          annualTax: Math.round(annualTax),
          annualInsurance: insuranceAnnual,
          annualMaintenance: Math.round(annualMaintenance),
          annualManagement: Math.round(annualManagement),
          totalAnnualExpenses: Math.round(totalExpenses),
        },
        returns: {
          netOperatingIncome: Math.round(noi),
          annualCashFlow: Math.round(cashFlow),
          monthlyCashFlow: Math.round(cashFlow / 12),
          capRate: Math.round(capRate * 100) / 100,
          cashOnCashReturn: Math.round(cashOnCash * 100) / 100,
          grossRentMultiplier: Math.round(grossRentMultiplier * 100) / 100,
          debtServiceCoverageRatio: Math.round(debtServiceCoverage * 100) / 100,
        },
        verdict:
          cashFlow > 0
            ? `Positive cash flow of $${Math.round(cashFlow / 12)}/month. ${capRate > 8 ? "Strong" : capRate > 5 ? "Moderate" : "Low"} cap rate at ${Math.round(capRate * 100) / 100}%.`
            : `Negative cash flow of $${Math.round(Math.abs(cashFlow) / 12)}/month. This property would cost money each month at these terms.`,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }],
      };
    }
  );

  // ================================================================
  // 10. GHL PILOT — Red Rock Real Estate sub-account (read-only)
  // ================================================================

  server.tool(
    "ghl-pilot:get_location",
    "Read-only. Fetch The Finest Homes / Red Rock Real Estate sub-account details from GHL.",
    {},
    async () => {
      const data = await ghlFetch(`/locations/${GHL_LOC}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ghl-pilot:search_contacts",
    "Read-only. Search contacts in the Red Rock Real Estate GHL sub-account.",
    {
      query: z.string().optional().describe("Name, email, or phone search string"),
      limit: z.number().optional().default(10).describe("Max results (1–100)"),
    },
    async ({ query, limit }) => {
      const body: Record<string, unknown> = { locationId: GHL_LOC, pageLimit: limit };
      if (query) body.query = query;
      const data = await ghlFetch("/contacts/search", { method: "POST", body });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ghl-pilot:get_contact",
    "Read-only. Fetch a single GHL contact by ID from the Red Rock Real Estate sub-account.",
    {
      contactId: z.string().describe("GHL contact ID"),
    },
    async ({ contactId }) => {
      const data = await ghlFetch(`/contacts/${contactId}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ghl-pilot:list_tags",
    "Read-only. List all contact tags defined in the Red Rock Real Estate GHL sub-account.",
    {},
    async () => {
      const data = await ghlFetch(`/locations/${GHL_LOC}/tags`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ghl-pilot:list_pipelines",
    "Read-only. List all opportunity pipelines and their stages in the Red Rock Real Estate GHL sub-account.",
    {},
    async () => {
      const data = await ghlFetch("/opportunities/pipelines", {
        queryParams: { locationId: GHL_LOC },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ghl-pilot:list_opportunities",
    "Read-only. List opportunities in the Red Rock Real Estate GHL sub-account, optionally filtered by pipeline or stage.",
    {
      pipelineId: z.string().optional().describe("Filter by pipeline ID"),
      stageId: z.string().optional().describe("Filter by pipeline stage ID"),
      limit: z.number().optional().default(50).describe("Max results (1–100)"),
    },
    async ({ pipelineId, stageId, limit }) => {
      const q: Record<string, string> = {
        location_id: GHL_LOC,
        limit: String(limit),
      };
      if (pipelineId) q.pipeline_id = pipelineId;
      if (stageId) q.pipeline_stage_id = stageId;
      const data = await ghlFetch("/opportunities/search", { queryParams: q });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ghl-pilot:get_opportunity",
    "Read-only. Fetch a single opportunity by ID from the Red Rock Real Estate GHL sub-account.",
    {
      opportunityId: z.string().describe("GHL opportunity ID"),
    },
    async ({ opportunityId }) => {
      const data = await ghlFetch(`/opportunities/${opportunityId}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ghl-pilot:list_calendars",
    "Read-only. List all calendars configured in the Red Rock Real Estate GHL sub-account.",
    {},
    async () => {
      const data = await ghlFetch("/calendars/", {
        queryParams: { locationId: GHL_LOC },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ghl-pilot:get_calendar_free_slots",
    "Read-only. Get available booking slots for a GHL calendar in the Red Rock Real Estate sub-account. Timestamps must be Unix milliseconds.",
    {
      calendarId: z.string().describe("GHL calendar ID"),
      startTimeMs: z.number().describe("Window start — Unix timestamp in milliseconds"),
      endTimeMs: z.number().describe("Window end — Unix timestamp in milliseconds"),
    },
    async ({ calendarId, startTimeMs, endTimeMs }) => {
      const data = await ghlFetch(`/calendars/${calendarId}/free-slots`, {
        queryParams: {
          startTime: String(startTimeMs),
          endTime: String(endTimeMs),
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ghl-pilot:list_custom_fields",
    "Read-only. List all custom contact/opportunity fields defined in the Red Rock Real Estate GHL sub-account.",
    {},
    async () => {
      const data = await ghlFetch(`/locations/${GHL_LOC}/customFields`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ghl-pilot:list_invoices",
    "Read-only. List invoices in the Red Rock Real Estate GHL sub-account.",
    {
      limit: z.number().optional().default(50).describe("Max results"),
      status: z
        .enum(["draft", "sent", "paid", "void", "partially_paid"])
        .optional()
        .describe("Filter by invoice status"),
    },
    async ({ limit, status }) => {
      const q: Record<string, string> = {
        locationId: GHL_LOC,
        limit: String(limit),
      };
      if (status) q.status = status;
      const data = await ghlFetch("/invoices/", { queryParams: q });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ghl-pilot:list_workflows",
    "Read-only. List all automation workflows in the Red Rock Real Estate GHL sub-account.",
    {},
    async () => {
      const data = await ghlFetch("/workflows/", {
        queryParams: { locationId: GHL_LOC },
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}

// Populate TOOL_DEFS at module load via a duck-typed recorder.
registerTools({
  tool(name: string, description: string, rawShape: ZodRawShape, handler: ToolHandler) {
    TOOL_DEFS.push({ name, description, rawShape, handler });
  },
});

/** Execute a tool by name, validating args with its Zod shape. */
export async function runTool(name: string, args: unknown): Promise<ToolResult> {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) throw new Error(`tool not found: ${name}`);
  const schema = z.object(def.rawShape);
  const parsed = schema.parse(args ?? {});
  return def.handler(parsed);
}

/** JSON-schema-compatible tool catalog for dashboard form rendering. */
export function getToolList() {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: rawShapeToJsonSchema(t.rawShape),
  }));
}

function rawShapeToJsonSchema(shape: ZodRawShape) {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const [key, raw] of Object.entries(shape)) {
    const { inner, isOptional, description } = unwrap(raw as any);
    const json = zodToJson(inner);
    if (description && !json.description) json.description = description;
    properties[key] = json;
    if (!isOptional) required.push(key);
  }
  return { type: "object" as const, properties, required };
}

function unwrap(z: any): { inner: any; isOptional: boolean; description?: string } {
  let node = z;
  let isOptional = false;
  let description: string | undefined;
  while (node?._def) {
    if (node._def.description && !description) description = node._def.description;
    const t = node._def.typeName;
    if (t === "ZodOptional" || t === "ZodDefault" || t === "ZodNullable") {
      isOptional = true;
      node = node._def.innerType;
    } else break;
  }
  return { inner: node, isOptional, description };
}

function zodToJson(z: any): any {
  if (!z?._def) return {};
  const t = z._def.typeName;
  const description = z._def.description;
  const withDesc = (obj: any) => (description ? { ...obj, description } : obj);
  if (t === "ZodString") return withDesc({ type: "string" });
  if (t === "ZodNumber") return withDesc({ type: "number" });
  if (t === "ZodBoolean") return withDesc({ type: "boolean" });
  if (t === "ZodEnum") return withDesc({ type: "string", enum: z._def.values });
  if (t === "ZodArray") return withDesc({ type: "array", items: zodToJson(z._def.type) });
  if (t === "ZodObject") {
    const shape = typeof z._def.shape === "function" ? z._def.shape() : z._def.shape;
    const sub = rawShapeToJsonSchema(shape);
    return withDesc({ type: "object", properties: sub.properties, required: sub.required });
  }
  if (t === "ZodOptional" || t === "ZodNullable" || t === "ZodDefault") return zodToJson(z._def.innerType);
  return withDesc({});
}

// Wrap every MCP route with fail-closed bearer auth.
// 503 if MISSION_CONTROL_TOKEN is unset (forces explicit setup before deploy works).
// 401 if token is missing or wrong.
function withBearerAuth(
  fn: (req: Request) => Response | Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (!process.env.MISSION_CONTROL_TOKEN) {
      return new Response("Auth not configured. Set MISSION_CONTROL_TOKEN.", { status: 503 });
    }
    const authHeader = req.headers.get("authorization") ?? "";
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m || !verifyToken(m[1])) {
      return new Response("Invalid or missing bearer token.", { status: 401 });
    }
    return fn(req);
  };
}

const _mcpHandler = createMcpHandler(registerTools);
const handler = withBearerAuth(_mcpHandler);

export { handler as GET, handler as POST, handler as DELETE };
