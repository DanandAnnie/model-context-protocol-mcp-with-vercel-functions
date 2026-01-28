# Annual Home Equity Report Automation - MCP Server

An MCP (Model Context Protocol) server deployed on Vercel that automates the generation of annual home equity reports for real estate professionals. This system calculates mortgage balances, equity positions, and generates personalized content including reports, emails, Loom video scripts, and SMS follow-ups.

## Overview

This automation transforms a manual 15-minute process into a scalable annual client engagement system. For each past client, the system:

1. Calculates estimated mortgage balance using amortization math
2. Computes equity position based on market value ranges
3. Generates a one-page equity report
4. Creates personalized email copy
5. Produces a Loom video script
6. Drafts a 48-hour SMS follow-up

## Available MCP Tools

### Core Calculation Tools

#### `calculate_mortgage_balance`
Calculates the estimated remaining mortgage balance based on purchase details.

**Inputs:**
- `purchasePrice` - Original purchase price
- `purchaseDate` - Purchase date (YYYY-MM-DD)
- `downPaymentPercent` - Down payment % (default: 20)
- `interestRate` - Annual interest rate (default: 3.0)
- `loanTermYears` - Loan term in years (default: 30)
- `calculationDate` - Optional date for calculation

**Returns:** Balance, months paid, payment breakdown, interest/principal paid

#### `calculate_equity`
Calculates home equity based on market value range and mortgage balance.

**Inputs:**
- `valueLow` - Low estimate of current market value
- `valueHigh` - High estimate of current market value
- `mortgageBalance` - Current mortgage balance
- `originalDownPayment` - Original down payment amount

**Returns:** Equity range, equity gained, ownership percentage

### Content Generation Tools

#### `generate_equity_report_package`
Generates a complete equity report package with all four deliverables.

**Inputs:**
- Client info (name, address)
- Purchase details (price, date)
- Calculated values (mortgage balance, equity)
- Market data (value range, YoY change)
- Personal insight about the property
- Report year

**Returns:**
1. One-page text equity report
2. Email copy (subject + body)
3. Loom video script (2-3 minutes)
4. 48-hour follow-up SMS

#### `process_client_for_report`
Main automation entry point - processes raw client data through the full pipeline.

**Inputs:**
- All client details and property information
- Market value estimates (low/high)
- Personal insight

**Returns:** Complete package with metadata, calculations, and all content ready for delivery

#### `batch_process_clients`
Processes multiple clients at once for bulk operations.

**Inputs:** Array of client data objects

**Returns:** Summary with aggregate equity stats and individual client readiness

### Utility Tools

#### `generate_client_data_template`
Generates templates for storing client data in various formats.

**Formats:**
- `json` - Full schema with example record
- `csv_headers` - CSV column headers
- `airtable_fields` - Airtable field definitions

## Data Schema

Required fields for each client:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| first_name | string | Yes | Client's first name |
| email | email | Yes | Email address |
| phone | phone | Yes | Phone for SMS |
| property_address | string | Yes | Full address |
| purchase_price | number | Yes | Original price |
| purchase_date | date | Yes | YYYY-MM-DD |
| down_payment_percent | number | No | Default 20% |
| interest_rate | number | No | Default 3.0% |
| loan_term_years | number | No | Default 30 |
| value_low | number | Yes* | Low comp estimate |
| value_high | number | Yes* | High comp estimate |
| personal_insight | text | Yes | Property-specific note |

*Required for report generation

## n8n Workflow Integration

This MCP server is designed to integrate with n8n automation workflows:

1. **Trigger**: Schedule Trigger (annually, e.g., Jan 5)
2. **Data Source**: Google Sheets/Airtable/CRM node
3. **Processing**: Call MCP tools via HTTP
4. **Delivery**: Email node with PDF attachment
5. **Follow-up**: Wait 48 hours, then SMS via Twilio

### Manual Steps (Preserved for Authenticity)

- Review comp range accuracy
- Record personalized Loom video (2-3 min)
- Add Loom link to email before sending

## MCP Client Integration

Add this server to your MCP client using your deployment URL:

```
https://your-deployment-url.vercel.app/mcp
```

## Deployment

### Vercel Configuration

- Enable [Fluid Compute](https://vercel.com/docs/functions/fluid-compute) for efficient execution
- Adjust `maxDuration` in `vercel.json` to 800 for Pro/Enterprise accounts
- Deploy via Vercel dashboard or CLI

### Local Development

```bash
vercel dev
```

### Testing

```bash
node scripts/test-client.mjs https://your-deployment-url.vercel.app
```

## Example Usage

### Single Client Report

```javascript
// Call process_client_for_report with:
{
  firstName: "Sarah",
  email: "sarah@example.com",
  phone: "+1-555-123-4567",
  propertyAddress: "123 Oak Street, Austin, TX 78701",
  purchasePrice: 425000,
  purchaseDate: "2020-03-15",
  downPaymentPercent: 20,
  interestRate: 3.25,
  loanTermYears: 30,
  valueLow: 515000,
  valueHigh: 555000,
  personalInsight: "Corner lot with mature trees. Kitchen remodeled in 2022.",
  marketYoYChange: 4.2
}
```

### Output Structure

```javascript
{
  metadata: {
    processedAt: "2025-01-28T...",
    reportYear: 2025,
    client: { firstName, email, phone, propertyAddress }
  },
  calculations: {
    mortgage: { originalLoanAmount, monthsPaid, estimatedBalance, downPayment },
    equity: { valueLow, valueHigh, equityLow, equityHigh, equityGainLow, equityGainHigh }
  },
  content: {
    report: "...",      // One-page text report
    emailCopy: "...",   // Subject + body
    loomScript: "...",  // 2-3 minute video script
    smsFollowUp: "..."  // 48-hour follow-up text
  },
  delivery: {
    emailReady: true,
    smsScheduleDelay: "48 hours",
    manualSteps: [...]
  }
}
```

## Philosophy

This system positions you as your client's "real estate CFO" by delivering annual equity reviews that:

- Create curiosity and conversation, not sales pitches
- Use value RANGES for honesty (not false precision)
- Include transparent market commentary
- Offer neutral options (move-up, invest, renovate)
- Personalize with property-specific insights

The goal is inbound conversations that lead to listings - without asking.

## License

ISC
