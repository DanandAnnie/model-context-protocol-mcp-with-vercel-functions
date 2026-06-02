// ============================================================
// Property Data Types - Mirrors PropertyRadar's data model
// ============================================================

export interface PropertyDetails {
  // Identification
  apn: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  county: string;
  latitude: number;
  longitude: number;
  fips: string;

  // Property Characteristics
  propertyType: string;
  propertyUse: string;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  lotSizeSqFt: number | null;
  lotSizeAcres: number | null;
  yearBuilt: number | null;
  stories: number | null;
  units: number | null;
  garage: string | null;
  pool: boolean | null;
  construction: string | null;
  roofType: string | null;
  heating: string | null;
  cooling: string | null;
  fireplace: boolean | null;
  zoning: string | null;
  subdivision: string | null;
  legalDescription: string | null;

  // Valuation
  estimatedValue: number | null;
  assessedTotalValue: number | null;
  assessedLandValue: number | null;
  assessedImprovementValue: number | null;
  marketValue: number | null;
  pricePerSqFt: number | null;
  lastSalePrice: number | null;
  lastSaleDate: string | null;
  equityEstimate: number | null;
  equityPercent: number | null;

  // Tax Information
  annualTaxAmount: number | null;
  taxYear: number | null;
  taxRateArea: string | null;
  taxDelinquent: boolean | null;
  taxDelinquentYear: number | null;
  exemptions: string[];

  // Owner Information
  owner: OwnerInfo;

  // Mortgage/Loan Data
  mortgages: MortgageInfo[];

  // Transfer History
  transferHistory: TransferRecord[];

  // Foreclosure Status
  foreclosure: ForeclosureInfo | null;

  // MLS / Listing Status
  listingStatus: string | null;
  listPrice: number | null;
  daysOnMarket: number | null;
  mlsNumber: string | null;
}

export interface OwnerInfo {
  name: string;
  ownerType: "individual" | "corporate" | "trust" | "government" | "unknown";
  mailingAddress: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
  ownerOccupied: boolean | null;
  phone: string | null;
  email: string | null;
  lengthOfOwnership: number | null; // years
  vestingType: string | null;
}

export interface MortgageInfo {
  position: number; // 1st, 2nd, etc.
  amount: number;
  date: string;
  lender: string | null;
  loanType: string | null; // conventional, FHA, VA, etc.
  interestRate: number | null;
  term: number | null; // months
  dueDate: string | null;
  estimatedBalance: number | null;
  estimatedPayment: number | null;
  armFlag: boolean | null;
}

export interface TransferRecord {
  date: string;
  price: number | null;
  buyerName: string | null;
  sellerName: string | null;
  documentType: string | null;
  documentNumber: string | null;
  transferType: string | null; // arms-length, non-arms-length, foreclosure
}

export interface ForeclosureInfo {
  status: "pre-foreclosure" | "auction" | "bank-owned" | "none";
  noticeType: string | null; // NOD, NTS, Lis Pendens
  recordingDate: string | null;
  auctionDate: string | null;
  defaultAmount: number | null;
  unpaidBalance: number | null;
  trustee: string | null;
  beneficiary: string | null;
  caseNumber: string | null;
}

export interface PropertySearchFilters {
  // Location
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  county?: string;
  apn?: string;
  radius?: number; // miles from lat/lng
  latitude?: number;
  longitude?: number;

  // Property
  propertyType?: string[];
  bedroomsMin?: number;
  bedroomsMax?: number;
  bathroomsMin?: number;
  bathroomsMax?: number;
  sqftMin?: number;
  sqftMax?: number;
  lotSizeMin?: number;
  lotSizeMax?: number;
  yearBuiltMin?: number;
  yearBuiltMax?: number;
  stories?: number;
  pool?: boolean;

  // Valuation
  valueMin?: number;
  valueMax?: number;
  equityMin?: number;
  equityMax?: number;
  equityPercentMin?: number;
  equityPercentMax?: number;

  // Owner
  ownerName?: string;
  ownerType?: string;
  ownerOccupied?: boolean;
  absenteeOwner?: boolean;
  lengthOfOwnershipMin?: number;
  lengthOfOwnershipMax?: number;
  corporateOwned?: boolean;
  trustOwned?: boolean;
  outOfStateOwner?: boolean;

  // Mortgage
  loanType?: string;
  hasMultipleMortgages?: boolean;
  armLoan?: boolean;
  highEquity?: boolean;
  freeClear?: boolean; // no mortgage

  // Distress
  preForeclosure?: boolean;
  auction?: boolean;
  bankOwned?: boolean;
  taxDelinquent?: boolean;

  // Sale / Listing
  listedForSale?: boolean;
  recentlySold?: boolean;
  soldWithinMonths?: number;
  lastSalePriceMin?: number;
  lastSalePriceMax?: number;
  cashBuyer?: boolean;

  // Pagination
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export interface PropertyAlert {
  id: string;
  name: string;
  filters: PropertySearchFilters;
  alertType: "new_listing" | "price_change" | "foreclosure" | "sale" | "all";
  frequency: "daily" | "weekly" | "immediate";
  createdAt: string;
  active: boolean;
}

export interface PropertyListSummary {
  totalProperties: number;
  averageValue: number;
  medianValue: number;
  totalEquity: number;
  averageEquity: number;
  ownerOccupiedCount: number;
  absenteeOwnerCount: number;
  foreclosureCount: number;
  averageYearBuilt: number;
  propertyTypeBreakdown: Record<string, number>;
}
