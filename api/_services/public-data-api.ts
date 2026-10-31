// ============================================================
// Public Data Sources Service
// Aggregates free/public APIs to supplement PropertyRadar data
// ============================================================

// ── 1. OpenStreetMap / Nominatim (Free geocoding) ────────────
export async function geocodeAddress(address: string): Promise<{
  latitude: number;
  longitude: number;
  displayName: string;
  county: string;
  state: string;
  zip: string;
} | null> {
  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?` +
      new URLSearchParams({
        q: address,
        format: "json",
        addressdetails: "1",
        limit: "1",
        countrycodes: "us",
      }),
    {
      headers: { "User-Agent": "PropertyMCPTool/1.0" },
    }
  );

  const results = await response.json();
  if (!results.length) return null;

  const r = results[0];
  return {
    latitude: parseFloat(r.lat),
    longitude: parseFloat(r.lon),
    displayName: r.display_name,
    county: r.address?.county || "",
    state: r.address?.state || "",
    zip: r.address?.postcode || "",
  };
}

export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<any> {
  const response = await fetch(
    `https://nominatim.openstreetmap.org/reverse?` +
      new URLSearchParams({
        lat: String(lat),
        lon: String(lng),
        format: "json",
        addressdetails: "1",
      }),
    {
      headers: { "User-Agent": "PropertyMCPTool/1.0" },
    }
  );
  return response.json();
}

// ── 2. Census Bureau API (Demographics & Housing) ────────────
export async function getCensusData(
  stateCode: string,
  countyCode: string
): Promise<{
  population: number;
  medianIncome: number;
  medianHomeValue: number;
  homeownerRate: number;
  vacancyRate: number;
  medianRent: number;
  totalHousingUnits: number;
} | null> {
  const apiKey = process.env.CENSUS_API_KEY || "";
  const variables = [
    "B01003_001E", // Total population
    "B19013_001E", // Median household income
    "B25077_001E", // Median home value
    "B25003_002E", // Owner occupied units
    "B25003_001E", // Total occupied units
    "B25002_003E", // Vacant units
    "B25002_001E", // Total housing units
    "B25064_001E", // Median gross rent
  ].join(",");

  const url =
    `https://api.census.gov/data/2022/acs/acs5?get=${variables}` +
    `&for=county:${countyCode}&in=state:${stateCode}` +
    (apiKey ? `&key=${apiKey}` : "");

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data || data.length < 2) return null;

    const values = data[1];
    const totalOccupied = parseInt(values[4]) || 1;
    const totalHousing = parseInt(values[6]) || 1;

    return {
      population: parseInt(values[0]) || 0,
      medianIncome: parseInt(values[1]) || 0,
      medianHomeValue: parseInt(values[2]) || 0,
      homeownerRate: Math.round(((parseInt(values[3]) || 0) / totalOccupied) * 100),
      vacancyRate: Math.round(((parseInt(values[5]) || 0) / totalHousing) * 100),
      medianRent: parseInt(values[7]) || 0,
      totalHousingUnits: parseInt(values[6]) || 0,
    };
  } catch (err) {
    console.error("Census API error:", err);
    return null;
  }
}

// ── 3. FIPS Code Lookup ──────────────────────────────────────
export async function getCountyFips(
  state: string,
  county: string
): Promise<{ stateCode: string; countyCode: string; fips: string } | null> {
  try {
    const response = await fetch(
      `https://api.census.gov/data/2022/acs/acs5?get=NAME&for=county:*&in=state:*`
    );
    const data = await response.json();
    if (!data) return null;

    const normalizedState = state.toLowerCase();
    const normalizedCounty = county.toLowerCase().replace(" county", "");

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const name = (row[0] as string).toLowerCase();
      if (
        name.includes(normalizedCounty) &&
        name.includes(normalizedState)
      ) {
        return {
          stateCode: row[1],
          countyCode: row[2],
          fips: `${row[1]}${row[2]}`,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── 4. Zillow / Zestimate via RapidAPI (Optional) ────────────
export async function getZillowEstimate(address: string): Promise<{
  zestimate: number;
  rentZestimate: number;
  lastSoldPrice: number;
  lastSoldDate: string;
  bedrooms: number;
  bathrooms: number;
  sqft: number;
  yearBuilt: number;
  propertyType: string;
  lotSize: number;
} | null> {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch(
      `https://zillow-com1.p.rapidapi.com/property?address=${encodeURIComponent(address)}`,
      {
        headers: {
          "x-rapidapi-key": apiKey,
          "x-rapidapi-host": "zillow-com1.p.rapidapi.com",
        },
      }
    );
    const data = await response.json();
    if (!data) return null;

    return {
      zestimate: data.zestimate || 0,
      rentZestimate: data.rentZestimate || 0,
      lastSoldPrice: data.lastSoldPrice || 0,
      lastSoldDate: data.dateSold || "",
      bedrooms: data.bedrooms || 0,
      bathrooms: data.bathrooms || 0,
      sqft: data.livingArea || 0,
      yearBuilt: data.yearBuilt || 0,
      propertyType: data.homeType || "",
      lotSize: data.lotSize || 0,
    };
  } catch {
    return null;
  }
}

// ── 5. ATTOM Data API (Property details, optional) ───────────
export async function getAttomPropertyData(
  address: string,
  zip: string
): Promise<any> {
  const apiKey = process.env.ATTOM_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch(
      `https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/expandedprofile?address1=${encodeURIComponent(address)}&address2=${encodeURIComponent(zip)}`,
      {
        headers: {
          apikey: apiKey,
          Accept: "application/json",
        },
      }
    );
    return response.json();
  } catch {
    return null;
  }
}

// ── 6. County Assessor Scraper (Generic public records) ──────
export async function getCountyAssessorData(
  county: string,
  state: string,
  apn: string
): Promise<any> {
  // County assessor websites vary by county.
  // This returns a structured lookup URL for manual review
  // or can be extended with county-specific parsers.
  const countySlug = county.toLowerCase().replace(/\s+/g, "-");
  const stateSlug = state.toLowerCase();

  // Common county assessor URL patterns
  const assessorUrls: Record<string, string> = {
    "los-angeles-california": `https://portal.assessor.lacounty.gov/parceldetail/${apn}`,
    "san-diego-california": `https://arcc-detail.sdcounty.ca.gov/parceldetailpage/Default.aspx?parcel=${apn}`,
    "orange-california": `https://www.ocgov.com/assessor/property-search?apn=${apn}`,
    "san-bernardino-california": `https://www.sbcounty.gov/assessor/parcelinfo.aspx?apn=${apn}`,
    "riverside-california": `https://rivcoassessor.org/parcel-search?apn=${apn}`,
    "maricopa-arizona": `https://mcassessor.maricopa.gov/mcs.php?q=${apn}`,
    "clark-nevada": `https://maps.clarkcountynv.gov/assessor/AssessorParcelDetail/`,
    "harris-texas": `https://public.hcad.org/records/details.asp?cession=&search=${apn}`,
    "cook-illinois": `https://www.cookcountyassessor.com/pin/${apn}`,
    "miami-dade-florida": `https://www.miamidade.gov/Apps/PA/PApublicServiceSearch/`,
    "king-washington": `https://blue.kingcounty.com/Assessor/eRealProperty/Dashboard.aspx?ParcelNbr=${apn}`,
  };

  const key = `${countySlug}-${stateSlug}`;

  return {
    county,
    state,
    apn,
    assessorUrl: assessorUrls[key] || null,
    message: assessorUrls[key]
      ? `County assessor lookup URL generated for ${county}, ${state}`
      : `No automated assessor lookup available for ${county}, ${state}. Visit the county assessor website directly.`,
  };
}

// ── 7. HUD Fair Market Rents ─────────────────────────────────
export async function getFairMarketRent(
  stateCode: string,
  countyCode: string,
  year: number = 2024
): Promise<any> {
  try {
    const response = await fetch(
      `https://www.huduser.gov/hudapi/public/fmr/data/${stateCode}${countyCode}?year=${year}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.HUD_API_KEY || ""}`,
        },
      }
    );
    return response.json();
  } catch {
    return null;
  }
}

// ── 8. Flood Zone Check (FEMA) ───────────────────────────────
export async function getFloodZone(
  lat: number,
  lng: number
): Promise<any> {
  try {
    const response = await fetch(
      `https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query?` +
        new URLSearchParams({
          geometry: `${lng},${lat}`,
          geometryType: "esriGeometryPoint",
          inSR: "4326",
          spatialRel: "esriSpatialRelIntersects",
          outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE",
          f: "json",
        })
    );
    const data = await response.json();
    if (data.features?.length) {
      const attrs = data.features[0].attributes;
      return {
        floodZone: attrs.FLD_ZONE,
        zoneSubtype: attrs.ZONE_SUBTY,
        specialFloodHazardArea: attrs.SFHA_TF === "T",
        baseFloodElevation: attrs.STATIC_BFE,
      };
    }
    return { floodZone: "Unknown", specialFloodHazardArea: false };
  } catch {
    return null;
  }
}

// ── 9. School Ratings (via Nominatim + NCES) ─────────────────
export async function getNearbySchools(
  lat: number,
  lng: number,
  radiusMiles: number = 5
): Promise<any> {
  // Use Overpass API to find nearby schools from OpenStreetMap
  const radiusMeters = radiusMiles * 1609.34;
  try {
    const query = `[out:json][timeout:10];(node["amenity"="school"](around:${radiusMeters},${lat},${lng});way["amenity"="school"](around:${radiusMeters},${lat},${lng}););out center body 20;`;
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const data = await response.json();
    return (data.elements || []).map((el: any) => ({
      name: el.tags?.name || "Unknown School",
      type: el.tags?.["school:type"] || el.tags?.["isced:level"] || "unknown",
      latitude: el.lat || el.center?.lat,
      longitude: el.lon || el.center?.lon,
      operator: el.tags?.operator || null,
    }));
  } catch {
    return [];
  }
}

// ── 10. Environmental / EPA Data ─────────────────────────────
export async function getEnvironmentalData(
  lat: number,
  lng: number
): Promise<any> {
  try {
    const response = await fetch(
      `https://enviro.epa.gov/enviro/efservice/getEnvirofactsUV/LATITUDE/${lat}/LONGITUDE/${lng}/JSON`
    );
    return response.json();
  } catch {
    return null;
  }
}
