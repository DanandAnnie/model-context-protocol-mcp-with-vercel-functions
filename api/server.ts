import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface MortgageCalculation {
  estimatedMortgageBalance: number;
  monthsPaid: number;
  originalLoanAmount: number;
  monthlyPayment: number;
  totalInterestPaid: number;
  principalPaid: number;
}

interface EquityCalculation {
  equityLow: number;
  equityHigh: number;
  equityGainLow: number;
  equityGainHigh: number;
  equityMidpoint: number;
  equityGainMidpoint: number;
  percentageEquityLow: number;
  percentageEquityHigh: number;
}

interface FullReportData {
  report: string;
  emailCopy: string;
  loomScript: string;
  smsFollowUp: string;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Calculate monthly mortgage payment using standard amortization formula
 */
function calculateMonthlyPayment(
  principal: number,
  annualRate: number,
  termYears: number
): number {
  const monthlyRate = annualRate / 100 / 12;
  const numPayments = termYears * 12;

  if (monthlyRate === 0) {
    return principal / numPayments;
  }

  return (
    (principal * monthlyRate * Math.pow(1 + monthlyRate, numPayments)) /
    (Math.pow(1 + monthlyRate, numPayments) - 1)
  );
}

/**
 * Calculate remaining mortgage balance after N months
 */
function calculateRemainingBalance(
  principal: number,
  annualRate: number,
  termYears: number,
  monthsPaid: number
): number {
  const monthlyRate = annualRate / 100 / 12;
  const numPayments = termYears * 12;

  if (monthlyRate === 0) {
    return principal - (principal / numPayments) * monthsPaid;
  }

  const monthlyPayment = calculateMonthlyPayment(principal, annualRate, termYears);

  return (
    principal * Math.pow(1 + monthlyRate, monthsPaid) -
    monthlyPayment * ((Math.pow(1 + monthlyRate, monthsPaid) - 1) / monthlyRate)
  );
}

/**
 * Calculate months between two dates
 */
function monthsBetweenDates(startDate: Date, endDate: Date): number {
  const months =
    (endDate.getFullYear() - startDate.getFullYear()) * 12 +
    (endDate.getMonth() - startDate.getMonth());
  return Math.max(0, months);
}

/**
 * Format currency for display
 */
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Format date for display
 */
function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

// ============================================================================
// MCP HANDLER SETUP
// ============================================================================

const handler = createMcpHandler((server) => {
  // ==========================================================================
  // TOOL: Calculate Mortgage Balance
  // ==========================================================================
  server.tool(
    "calculate_mortgage_balance",
    "Calculates the estimated remaining mortgage balance based on purchase details and amortization schedule. Returns balance, months paid, payment breakdown, and interest/principal paid to date.",
    {
      purchasePrice: z.number().positive().describe("Original purchase price of the home"),
      purchaseDate: z.string().describe("Purchase date in ISO format (YYYY-MM-DD)"),
      downPaymentPercent: z.number().min(0).max(100).default(20).describe("Down payment percentage (default 20%)"),
      interestRate: z.number().min(0).max(20).default(3.0).describe("Annual interest rate percentage (default 3.0%)"),
      loanTermYears: z.number().int().min(1).max(40).default(30).describe("Loan term in years (default 30)"),
      calculationDate: z.string().optional().describe("Date to calculate balance for (defaults to today)"),
    },
    async ({ purchasePrice, purchaseDate, downPaymentPercent, interestRate, loanTermYears, calculationDate }) => {
      const purchaseDateObj = new Date(purchaseDate);
      const calcDateObj = calculationDate ? new Date(calculationDate) : new Date();

      const downPayment = purchasePrice * (downPaymentPercent / 100);
      const originalLoanAmount = purchasePrice - downPayment;
      const monthsPaid = monthsBetweenDates(purchaseDateObj, calcDateObj);

      const monthlyPayment = calculateMonthlyPayment(originalLoanAmount, interestRate, loanTermYears);
      const remainingBalance = Math.max(0, calculateRemainingBalance(
        originalLoanAmount,
        interestRate,
        loanTermYears,
        monthsPaid
      ));

      const totalPaid = monthlyPayment * monthsPaid;
      const principalPaid = originalLoanAmount - remainingBalance;
      const totalInterestPaid = totalPaid - principalPaid;

      const result: MortgageCalculation = {
        estimatedMortgageBalance: Math.round(remainingBalance),
        monthsPaid,
        originalLoanAmount: Math.round(originalLoanAmount),
        monthlyPayment: Math.round(monthlyPayment),
        totalInterestPaid: Math.round(totalInterestPaid),
        principalPaid: Math.round(principalPaid),
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...result,
            formatted: {
              estimatedMortgageBalance: formatCurrency(result.estimatedMortgageBalance),
              originalLoanAmount: formatCurrency(result.originalLoanAmount),
              monthlyPayment: formatCurrency(result.monthlyPayment),
              totalInterestPaid: formatCurrency(result.totalInterestPaid),
              principalPaid: formatCurrency(result.principalPaid),
              yearsMonthsPaid: `${Math.floor(monthsPaid / 12)} years, ${monthsPaid % 12} months`,
            }
          }, null, 2),
        }],
      };
    }
  );

  // ==========================================================================
  // TOOL: Calculate Equity
  // ==========================================================================
  server.tool(
    "calculate_equity",
    "Calculates home equity based on current market value range and mortgage balance. Returns equity range, equity gained since purchase, and percentage of home owned.",
    {
      valueLow: z.number().positive().describe("Low estimate of current market value"),
      valueHigh: z.number().positive().describe("High estimate of current market value"),
      mortgageBalance: z.number().min(0).describe("Current estimated mortgage balance"),
      originalDownPayment: z.number().min(0).describe("Original down payment amount"),
    },
    async ({ valueLow, valueHigh, mortgageBalance, originalDownPayment }) => {
      const equityLow = valueLow - mortgageBalance;
      const equityHigh = valueHigh - mortgageBalance;
      const equityMidpoint = (equityLow + equityHigh) / 2;

      const equityGainLow = equityLow - originalDownPayment;
      const equityGainHigh = equityHigh - originalDownPayment;
      const equityGainMidpoint = (equityGainLow + equityGainHigh) / 2;

      const percentageEquityLow = (equityLow / valueLow) * 100;
      const percentageEquityHigh = (equityHigh / valueHigh) * 100;

      const result: EquityCalculation = {
        equityLow: Math.round(equityLow),
        equityHigh: Math.round(equityHigh),
        equityGainLow: Math.round(equityGainLow),
        equityGainHigh: Math.round(equityGainHigh),
        equityMidpoint: Math.round(equityMidpoint),
        equityGainMidpoint: Math.round(equityGainMidpoint),
        percentageEquityLow: Math.round(percentageEquityLow * 10) / 10,
        percentageEquityHigh: Math.round(percentageEquityHigh * 10) / 10,
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...result,
            formatted: {
              equityRange: `${formatCurrency(result.equityLow)} - ${formatCurrency(result.equityHigh)}`,
              equityGainRange: `${formatCurrency(result.equityGainLow)} - ${formatCurrency(result.equityGainHigh)}`,
              equityMidpoint: formatCurrency(result.equityMidpoint),
              equityGainMidpoint: formatCurrency(result.equityGainMidpoint),
              ownershipRange: `${result.percentageEquityLow}% - ${result.percentageEquityHigh}%`,
            }
          }, null, 2),
        }],
      };
    }
  );

  // ==========================================================================
  // TOOL: Generate Full Equity Report Package
  // ==========================================================================
  server.tool(
    "generate_equity_report_package",
    "Generates a complete equity report package including: 1) One-page equity report, 2) Email copy, 3) Loom video script, and 4) 48-hour follow-up SMS. All content is personalized and follows a professional, non-salesy advisor tone.",
    {
      firstName: z.string().describe("Homeowner's first name"),
      address: z.string().describe("Property address"),
      purchasePrice: z.number().positive().describe("Original purchase price"),
      purchaseDate: z.string().describe("Purchase date (YYYY-MM-DD)"),
      mortgageBalance: z.number().min(0).describe("Estimated current mortgage balance"),
      valueLow: z.number().positive().describe("Low estimate of current market value"),
      valueHigh: z.number().positive().describe("High estimate of current market value"),
      equityLow: z.number().describe("Low estimate of current equity"),
      equityHigh: z.number().describe("High estimate of current equity"),
      equityGainLow: z.number().describe("Low estimate of equity gained since purchase"),
      equityGainHigh: z.number().describe("High estimate of equity gained since purchase"),
      marketYoYChange: z.number().describe("Year-over-year market change percentage"),
      personalInsight: z.string().describe("Personal property insight (pool, remodel, location advantage, etc.)"),
      reportYear: z.number().int().describe("Year for the report (e.g., 2025)"),
    },
    async ({
      firstName,
      address,
      purchasePrice,
      purchaseDate,
      mortgageBalance,
      valueLow,
      valueHigh,
      equityLow,
      equityHigh,
      equityGainLow,
      equityGainHigh,
      marketYoYChange,
      personalInsight,
      reportYear,
    }) => {
      const purchaseDateObj = new Date(purchaseDate);
      const yearsOwned = Math.floor((new Date().getTime() - purchaseDateObj.getTime()) / (365.25 * 24 * 60 * 60 * 1000));

      // ========================================
      // SECTION 1: One-Page Equity Report
      // ========================================
      const report = `
================================================================================
                    ${reportYear} HOME EQUITY REPORT
                    ${address}
================================================================================

PURCHASE SUMMARY
--------------------------------------------------------------------------------
Purchase Date:           ${formatDate(purchaseDateObj)}
Original Purchase Price: ${formatCurrency(purchasePrice)}
Years Owned:             ${yearsOwned} years

CURRENT MARKET ANALYSIS
--------------------------------------------------------------------------------
Estimated Value Range:   ${formatCurrency(valueLow)} - ${formatCurrency(valueHigh)}
Estimated Mortgage:      ${formatCurrency(mortgageBalance)}

YOUR EQUITY POSITION
--------------------------------------------------------------------------------
Estimated Equity:        ${formatCurrency(equityLow)} - ${formatCurrency(equityHigh)}
Equity Gained:           ${formatCurrency(equityGainLow)} - ${formatCurrency(equityGainHigh)}
                         (since purchase)

MARKET TRANSPARENCY
--------------------------------------------------------------------------------
Local Market Change (YoY): ${marketYoYChange > 0 ? '+' : ''}${marketYoYChange}%

Real estate values fluctuate based on market conditions, comparable sales, and
property-specific factors. This report uses a value RANGE rather than a single
number to provide a more honest picture of where your home likely sits in
today's market.

WHAT THIS COULD MEAN FOR YOU
--------------------------------------------------------------------------------
Your equity represents real wealth that can be leveraged in several ways:

  1. MOVE-UP OPPORTUNITY
     Your equity could serve as a substantial down payment on a larger home
     or a property in a different location that better fits your lifestyle.

  2. INVESTMENT POTENTIAL
     Home equity can be used to diversify into other investments, fund a
     rental property purchase, or create additional income streams.

  3. HOME IMPROVEMENT
     Strategic renovations could further increase your property value while
     improving your quality of life in your current home.

PERSONALIZED INSIGHT
--------------------------------------------------------------------------------
${personalInsight}

--------------------------------------------------------------------------------
This report is provided for informational purposes. For precise valuations,
a professional appraisal or comparative market analysis is recommended.
================================================================================
`.trim();

      // ========================================
      // SECTION 2: Email Copy
      // ========================================
      const emailCopy = `Subject: Your ${reportYear} Home Equity Report for ${address}

Hi ${firstName},

Your home is likely your largest asset, yet most homeowners go years without checking in on its performance.

I put together your ${reportYear} Annual Home Equity Report as part of my commitment to keeping past clients informed about their real estate position.

The attached report includes:
- Your estimated current home value (as a range, not a guess)
- Your approximate equity position
- How much wealth you've built since purchasing

I also recorded a short 2-3 minute video walking through the key numbers and what they might mean for your situation.

If you're curious about your options over the next few years, whether that's staying put, making improvements, or exploring what's out there, I'm always happy to talk it through. No agenda, just information.

Best,
[Your Name]`;

      // ========================================
      // SECTION 3: Loom Video Script
      // ========================================
      const loomScript = `LOOM VIDEO SCRIPT - ${firstName}'s ${reportYear} Equity Report
Duration: 2-3 minutes
--------------------------------------------------------------------------------

[OPENING - On camera, warm and direct]

"Hey ${firstName}, I wanted to send you a quick personal video to walk through your annual home equity report.

I do this every year for my past clients because I think it's important for homeowners to understand where they stand financially, especially with their biggest asset.

[TRANSITION - Share screen showing the report]

So here's what I put together for ${address}.

[KEY DATA POINTS]

You purchased back in ${formatDate(purchaseDateObj)} for ${formatCurrency(purchasePrice)}.

Based on recent sales in your area and current market conditions, I'm estimating your home's value is somewhere in the range of ${formatCurrency(valueLow)} to ${formatCurrency(valueHigh)}.

Now, I always use a range because real estate isn't an exact science, and I'd rather give you an honest picture than a false precision.

[EQUITY HIGHLIGHT]

What that means for your equity position, after accounting for your remaining mortgage, you're looking at roughly ${formatCurrency(equityLow)} to ${formatCurrency(equityHigh)} in equity.

That's ${formatCurrency(equityGainLow)} to ${formatCurrency(equityGainHigh)} in wealth you've built since you bought the place. That's real money.

[MARKET CONTEXT]

The local market has shifted about ${marketYoYChange > 0 ? '+' : ''}${marketYoYChange}% over the past year. ${marketYoYChange > 0 ? "That's worked in your favor." : marketYoYChange < 0 ? "It's been a bit softer, but your long-term position remains strong." : "It's been relatively stable."}

[PERSONALIZED NOTE]

One thing I wanted to mention specifically about your property: ${personalInsight}

[SOFT CLOSE - Back on camera]

Anyway, that's the overview. This isn't a sales call or anything like that. I just believe in keeping my clients informed.

If you ever want to talk through what this means for your 3 to 5 year plan, whether you're thinking about staying, renovating, or eventually making a move, I'm always here as a resource.

Hope you and the family are doing well. Talk soon."

[END]
--------------------------------------------------------------------------------`;

      // ========================================
      // SECTION 4: 48-Hour Follow-Up SMS
      // ========================================
      const smsFollowUp = `Hey ${firstName}, just wanted to make sure the equity report I sent over didn't get buried in your inbox. Curious, was the ${formatCurrency(valueLow)} to ${formatCurrency(valueHigh)} range higher or lower than you were expecting?`;

      const result: FullReportData = {
        report,
        emailCopy,
        loomScript,
        smsFollowUp,
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // ==========================================================================
  // TOOL: Generate Client Data Template
  // ==========================================================================
  server.tool(
    "generate_client_data_template",
    "Generates a JSON template for storing client data required for equity reports. Use this to set up your data storage structure in a spreadsheet, CRM, or database.",
    {
      format: z.enum(["json", "csv_headers", "airtable_fields"]).default("json").describe("Output format for the template"),
    },
    async ({ format }) => {
      const fields = [
        { name: "client_id", type: "string", required: true, description: "Unique client identifier" },
        { name: "first_name", type: "string", required: true, description: "Client's first name" },
        { name: "last_name", type: "string", required: false, description: "Client's last name" },
        { name: "email", type: "email", required: true, description: "Client's email address" },
        { name: "phone", type: "phone", required: true, description: "Client's phone number for SMS" },
        { name: "property_address", type: "string", required: true, description: "Full property address" },
        { name: "purchase_price", type: "number", required: true, description: "Original purchase price" },
        { name: "purchase_date", type: "date", required: true, description: "Date of purchase (YYYY-MM-DD)" },
        { name: "down_payment_percent", type: "number", required: false, description: "Down payment percentage (default 20)" },
        { name: "interest_rate", type: "number", required: false, description: "Mortgage interest rate (default 3.0)" },
        { name: "loan_term_years", type: "number", required: false, description: "Loan term in years (default 30)" },
        { name: "value_low", type: "number", required: false, description: "Low comp estimate (manual input)" },
        { name: "value_high", type: "number", required: false, description: "High comp estimate (manual input)" },
        { name: "personal_insight", type: "text", required: false, description: "Property-specific insight" },
        { name: "last_report_sent", type: "date", required: false, description: "Date of last equity report sent" },
        { name: "tags", type: "array", required: false, description: "Client tags (Past Client, A+ Client, etc.)" },
        { name: "notes", type: "text", required: false, description: "Additional notes" },
      ];

      let output: string;

      if (format === "csv_headers") {
        output = fields.map(f => f.name).join(",");
      } else if (format === "airtable_fields") {
        output = JSON.stringify(fields.map(f => ({
          name: f.name,
          type: f.type === "number" ? "number" :
                f.type === "date" ? "date" :
                f.type === "email" ? "email" :
                f.type === "phone" ? "phoneNumber" :
                f.type === "array" ? "multipleSelects" :
                f.type === "text" ? "multilineText" : "singleLineText",
          required: f.required,
          description: f.description,
        })), null, 2);
      } else {
        output = JSON.stringify({
          schema_version: "1.0",
          fields,
          example_record: {
            client_id: "CLT-001",
            first_name: "Sarah",
            last_name: "Johnson",
            email: "sarah.johnson@email.com",
            phone: "+1-555-123-4567",
            property_address: "123 Oak Street, Austin, TX 78701",
            purchase_price: 425000,
            purchase_date: "2020-03-15",
            down_payment_percent: 20,
            interest_rate: 3.25,
            loan_term_years: 30,
            value_low: 515000,
            value_high: 555000,
            personal_insight: "Corner lot with mature trees. Kitchen was fully remodeled in 2022 which adds value above standard comps.",
            last_report_sent: "2024-01-10",
            tags: ["Past Client", "A+ Client"],
            notes: "Referred her sister who bought on Maple Ave. Great relationship.",
          }
        }, null, 2);
      }

      return {
        content: [{
          type: "text",
          text: output,
        }],
      };
    }
  );

  // ==========================================================================
  // TOOL: Process Client for Report Generation
  // ==========================================================================
  server.tool(
    "process_client_for_report",
    "Takes raw client data and processes it through the full equity report pipeline. Returns all calculated values and generated content ready for delivery. This is the main automation entry point.",
    {
      firstName: z.string().describe("Client's first name"),
      email: z.string().email().describe("Client's email address"),
      phone: z.string().describe("Client's phone number"),
      propertyAddress: z.string().describe("Full property address"),
      purchasePrice: z.number().positive().describe("Original purchase price"),
      purchaseDate: z.string().describe("Purchase date (YYYY-MM-DD)"),
      downPaymentPercent: z.number().min(0).max(100).default(20).describe("Down payment percentage"),
      interestRate: z.number().min(0).max(20).default(3.0).describe("Annual interest rate"),
      loanTermYears: z.number().int().min(1).max(40).default(30).describe("Loan term in years"),
      valueLow: z.number().positive().describe("Low market value estimate from comps"),
      valueHigh: z.number().positive().describe("High market value estimate from comps"),
      personalInsight: z.string().describe("Property-specific insight"),
      marketYoYChange: z.number().default(0).describe("Year-over-year market change percentage"),
    },
    async ({
      firstName,
      email,
      phone,
      propertyAddress,
      purchasePrice,
      purchaseDate,
      downPaymentPercent,
      interestRate,
      loanTermYears,
      valueLow,
      valueHigh,
      personalInsight,
      marketYoYChange,
    }) => {
      const reportYear = new Date().getFullYear();
      const purchaseDateObj = new Date(purchaseDate);
      const today = new Date();

      // Step 1: Calculate mortgage balance
      const downPayment = purchasePrice * (downPaymentPercent / 100);
      const originalLoanAmount = purchasePrice - downPayment;
      const monthsPaid = monthsBetweenDates(purchaseDateObj, today);
      const mortgageBalance = Math.round(Math.max(0, calculateRemainingBalance(
        originalLoanAmount,
        interestRate,
        loanTermYears,
        monthsPaid
      )));

      // Step 2: Calculate equity
      const equityLow = valueLow - mortgageBalance;
      const equityHigh = valueHigh - mortgageBalance;
      const equityGainLow = equityLow - downPayment;
      const equityGainHigh = equityHigh - downPayment;

      // Step 3: Generate report content
      const yearsOwned = Math.floor((today.getTime() - purchaseDateObj.getTime()) / (365.25 * 24 * 60 * 60 * 1000));

      // Full report text
      const report = `
================================================================================
                    ${reportYear} HOME EQUITY REPORT
                    ${propertyAddress}
================================================================================

PURCHASE SUMMARY
--------------------------------------------------------------------------------
Purchase Date:           ${formatDate(purchaseDateObj)}
Original Purchase Price: ${formatCurrency(purchasePrice)}
Years Owned:             ${yearsOwned} years

CURRENT MARKET ANALYSIS
--------------------------------------------------------------------------------
Estimated Value Range:   ${formatCurrency(valueLow)} - ${formatCurrency(valueHigh)}
Estimated Mortgage:      ${formatCurrency(mortgageBalance)}

YOUR EQUITY POSITION
--------------------------------------------------------------------------------
Estimated Equity:        ${formatCurrency(equityLow)} - ${formatCurrency(equityHigh)}
Equity Gained:           ${formatCurrency(equityGainLow)} - ${formatCurrency(equityGainHigh)}
                         (since purchase)

MARKET TRANSPARENCY
--------------------------------------------------------------------------------
Local Market Change (YoY): ${marketYoYChange > 0 ? '+' : ''}${marketYoYChange}%

Real estate values fluctuate based on market conditions, comparable sales, and
property-specific factors. This report uses a value RANGE rather than a single
number to provide a more honest picture of where your home likely sits in
today's market.

WHAT THIS COULD MEAN FOR YOU
--------------------------------------------------------------------------------
Your equity represents real wealth that can be leveraged in several ways:

  1. MOVE-UP OPPORTUNITY
     Your equity could serve as a substantial down payment on a larger home
     or a property in a different location that better fits your lifestyle.

  2. INVESTMENT POTENTIAL
     Home equity can be used to diversify into other investments, fund a
     rental property purchase, or create additional income streams.

  3. HOME IMPROVEMENT
     Strategic renovations could further increase your property value while
     improving your quality of life in your current home.

PERSONALIZED INSIGHT
--------------------------------------------------------------------------------
${personalInsight}

--------------------------------------------------------------------------------
This report is provided for informational purposes. For precise valuations,
a professional appraisal or comparative market analysis is recommended.
================================================================================
`.trim();

      // Email copy
      const emailCopy = `Subject: Your ${reportYear} Home Equity Report for ${propertyAddress}

Hi ${firstName},

Your home is likely your largest asset, yet most homeowners go years without checking in on its performance.

I put together your ${reportYear} Annual Home Equity Report as part of my commitment to keeping past clients informed about their real estate position.

The attached report includes:
- Your estimated current home value (as a range, not a guess)
- Your approximate equity position
- How much wealth you've built since purchasing

I also recorded a short 2-3 minute video walking through the key numbers and what they might mean for your situation.

If you're curious about your options over the next few years, whether that's staying put, making improvements, or exploring what's out there, I'm always happy to talk it through. No agenda, just information.

Best,
[Your Name]`;

      // Loom script
      const loomScript = `LOOM VIDEO SCRIPT - ${firstName}'s ${reportYear} Equity Report
Duration: 2-3 minutes
--------------------------------------------------------------------------------

[OPENING - On camera, warm and direct]

"Hey ${firstName}, I wanted to send you a quick personal video to walk through your annual home equity report.

I do this every year for my past clients because I think it's important for homeowners to understand where they stand financially, especially with their biggest asset.

[TRANSITION - Share screen showing the report]

So here's what I put together for ${propertyAddress}.

[KEY DATA POINTS]

You purchased back in ${formatDate(purchaseDateObj)} for ${formatCurrency(purchasePrice)}.

Based on recent sales in your area and current market conditions, I'm estimating your home's value is somewhere in the range of ${formatCurrency(valueLow)} to ${formatCurrency(valueHigh)}.

Now, I always use a range because real estate isn't an exact science, and I'd rather give you an honest picture than a false precision.

[EQUITY HIGHLIGHT]

What that means for your equity position, after accounting for your remaining mortgage, you're looking at roughly ${formatCurrency(equityLow)} to ${formatCurrency(equityHigh)} in equity.

That's ${formatCurrency(equityGainLow)} to ${formatCurrency(equityGainHigh)} in wealth you've built since you bought the place. That's real money.

[MARKET CONTEXT]

The local market has shifted about ${marketYoYChange > 0 ? '+' : ''}${marketYoYChange}% over the past year. ${marketYoYChange > 0 ? "That's worked in your favor." : marketYoYChange < 0 ? "It's been a bit softer, but your long-term position remains strong." : "It's been relatively stable."}

[PERSONALIZED NOTE]

One thing I wanted to mention specifically about your property: ${personalInsight}

[SOFT CLOSE - Back on camera]

Anyway, that's the overview. This isn't a sales call or anything like that. I just believe in keeping my clients informed.

If you ever want to talk through what this means for your 3 to 5 year plan, whether you're thinking about staying, renovating, or eventually making a move, I'm always here as a resource.

Hope you and the family are doing well. Talk soon."

[END]
--------------------------------------------------------------------------------`;

      // SMS follow-up
      const smsFollowUp = `Hey ${firstName}, just wanted to make sure the equity report I sent over didn't get buried in your inbox. Curious, was the ${formatCurrency(valueLow)} to ${formatCurrency(valueHigh)} range higher or lower than you were expecting?`;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            metadata: {
              processedAt: today.toISOString(),
              reportYear,
              client: {
                firstName,
                email,
                phone,
                propertyAddress,
              }
            },
            calculations: {
              mortgage: {
                originalLoanAmount: Math.round(originalLoanAmount),
                monthsPaid,
                estimatedBalance: mortgageBalance,
                downPayment: Math.round(downPayment),
              },
              equity: {
                valueLow,
                valueHigh,
                equityLow: Math.round(equityLow),
                equityHigh: Math.round(equityHigh),
                equityGainLow: Math.round(equityGainLow),
                equityGainHigh: Math.round(equityGainHigh),
              }
            },
            content: {
              report,
              emailCopy,
              loomScript,
              smsFollowUp,
            },
            delivery: {
              emailReady: true,
              smsScheduleDelay: "48 hours",
              manualSteps: [
                "Review comp values for accuracy",
                "Record personalized Loom video",
                "Add Loom link to email before sending",
              ]
            }
          }, null, 2),
        }],
      };
    }
  );

  // ==========================================================================
  // TOOL: Batch Process Multiple Clients
  // ==========================================================================
  server.tool(
    "batch_process_clients",
    "Processes multiple clients at once and returns a summary of all reports generated. Input is an array of client data objects. Returns aggregated results for bulk operations.",
    {
      clients: z.array(z.object({
        firstName: z.string(),
        email: z.string().email(),
        phone: z.string(),
        propertyAddress: z.string(),
        purchasePrice: z.number().positive(),
        purchaseDate: z.string(),
        downPaymentPercent: z.number().min(0).max(100).optional(),
        interestRate: z.number().min(0).max(20).optional(),
        loanTermYears: z.number().int().min(1).max(40).optional(),
        valueLow: z.number().positive(),
        valueHigh: z.number().positive(),
        personalInsight: z.string(),
        marketYoYChange: z.number().optional(),
      })).describe("Array of client data objects to process"),
    },
    async ({ clients }) => {
      const reportYear = new Date().getFullYear();
      const today = new Date();
      const results: Array<{
        client: string;
        email: string;
        equityRange: string;
        status: string;
      }> = [];

      let totalEquityLow = 0;
      let totalEquityHigh = 0;

      for (const client of clients) {
        const downPaymentPercent = client.downPaymentPercent ?? 20;
        const interestRate = client.interestRate ?? 3.0;
        const loanTermYears = client.loanTermYears ?? 30;
        const marketYoYChange = client.marketYoYChange ?? 0;

        const purchaseDateObj = new Date(client.purchaseDate);
        const downPayment = client.purchasePrice * (downPaymentPercent / 100);
        const originalLoanAmount = client.purchasePrice - downPayment;
        const monthsPaid = monthsBetweenDates(purchaseDateObj, today);
        const mortgageBalance = Math.max(0, calculateRemainingBalance(
          originalLoanAmount,
          interestRate,
          loanTermYears,
          monthsPaid
        ));

        const equityLow = client.valueLow - mortgageBalance;
        const equityHigh = client.valueHigh - mortgageBalance;

        totalEquityLow += equityLow;
        totalEquityHigh += equityHigh;

        results.push({
          client: client.firstName,
          email: client.email,
          equityRange: `${formatCurrency(equityLow)} - ${formatCurrency(equityHigh)}`,
          status: "ready",
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: {
              totalClients: clients.length,
              reportYear,
              processedAt: today.toISOString(),
              aggregateEquity: {
                totalEquityLow: formatCurrency(totalEquityLow),
                totalEquityHigh: formatCurrency(totalEquityHigh),
                averageEquityLow: formatCurrency(totalEquityLow / clients.length),
                averageEquityHigh: formatCurrency(totalEquityHigh / clients.length),
              }
            },
            clients: results,
            nextSteps: [
              "Review each client's comp values for accuracy",
              "Generate individual reports using process_client_for_report",
              "Record personalized Loom videos",
              "Schedule email delivery",
              "Set up 48-hour SMS follow-ups",
            ]
          }, null, 2),
        }],
      };
    }
  );

  // ==========================================================================
  // Keep original example tools for reference
  // ==========================================================================
  server.tool(
    "roll_dice",
    "Rolls an N-sided die (example tool)",
    { sides: z.number().int().min(2) },
    async ({ sides }) => {
      const value = 1 + Math.floor(Math.random() * sides);
      return {
        content: [{ type: "text", text: `You rolled a ${value}!` }],
      };
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
