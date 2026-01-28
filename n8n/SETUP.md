# n8n Workflow Setup Guide

## Quick Start

### 1. Import the Workflow

1. Open your n8n instance
2. Go to **Workflows** in the sidebar
3. Click **Add Workflow** > **Import from File**
4. Select `equity-report-workflow.json`

### 2. Set Up Variables

Go to **Settings** > **Variables** and create:

| Variable | Value | Description |
|----------|-------|-------------|
| `MCP_SERVER_URL` | `https://your-app.vercel.app` | Your Vercel deployment URL |
| `GOOGLE_SHEET_ID` | `1abc...xyz` | Your Google Sheet document ID |
| `TWILIO_PHONE_NUMBER` | `+15551234567` | Your Twilio phone number |

### 3. Create Credentials

#### Google Sheets OAuth2
1. Go to **Settings** > **Credentials** > **Add Credential**
2. Search for "Google Sheets"
3. Select "OAuth2"
4. Follow the Google Cloud Console setup:
   - Create a project at console.cloud.google.com
   - Enable Google Sheets API
   - Create OAuth2 credentials
   - Add your n8n callback URL

#### SMTP (Email)
1. Add credential for "SMTP"
2. Configure:
   - Host: `smtp.gmail.com` (or your provider)
   - Port: `587`
   - User: Your email
   - Password: App password (not regular password)

#### Twilio API
1. Add credential for "Twilio API"
2. Get from twilio.com/console:
   - Account SID
   - Auth Token

### 4. Prepare Google Sheet

Create a Google Sheet with two tabs:

#### Tab 1: "Clients"
Required columns:
```
first_name | email | phone | property_address | purchase_price | purchase_date | down_payment_percent | interest_rate | loan_term_years | value_low | value_high | personal_insight | market_yoy_change
```

#### Tab 2: "Report Log"
Required columns:
```
timestamp | client_name | client_email | property_address | equity_low | equity_high | status
```

### 5. Test the Workflow

1. Add a test client to your Google Sheet with all required fields
2. Make sure `value_low` and `value_high` are filled (clients without these are filtered out)
3. Click **Manual Test Trigger** node
4. Click **Test Workflow**
5. Check each node's output for errors

## Workflow Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Annual Trigger │────▶│  Get Clients    │────▶│  Filter Ready   │
│  (Jan 5, 9 AM)  │     │  from Sheet     │     │  Clients        │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                                                │
        │                                                ▼
┌─────────────────┐                          ┌─────────────────┐
│  Manual Test    │─────────────────────────▶│  Generate via   │
│  Trigger        │                          │  MCP Server     │
└─────────────────┘                          └─────────────────┘
                                                      │
                                                      ▼
                                             ┌─────────────────┐
                                             │  Parse Report   │
                                             │  Data           │
                                             └─────────────────┘
                                                      │
                              ┌────────────────────────┴────────────────────────┐
                              ▼                                                 ▼
                    ┌─────────────────┐                               ┌─────────────────┐
                    │  Prepare File   │                               │  Wait 48 Hours  │
                    │  & Send Email   │                               │                 │
                    └─────────────────┘                               └─────────────────┘
                              │                                                 │
                              ▼                                                 ▼
                    ┌─────────────────┐                               ┌─────────────────┐
                    │  Log Report     │                               │  Has Phone?     │
                    │  Sent           │                               │                 │
                    └─────────────────┘                               └─────────────────┘
                                                                       │           │
                                                                  Yes  ▼           ▼  No
                                                            ┌───────────┐   ┌───────────┐
                                                            │ Send SMS  │   │ Log Skip  │
                                                            └───────────┘   └───────────┘
```

## Nodes Explained

| Node | Purpose |
|------|---------|
| **Annual Trigger** | Fires automatically on January 5th at 9 AM |
| **Manual Test Trigger** | Use this for testing anytime |
| **Get All Clients** | Pulls all rows from the Clients tab |
| **Filter Ready Clients** | Only processes clients with `value_low` > 0 and valid email |
| **Generate Report via MCP** | Calls your Vercel-hosted MCP server |
| **Parse Report Data** | Extracts email, SMS, and report content from MCP response |
| **Prepare Report File** | Formats data for file creation |
| **Convert to File** | Creates .txt attachment |
| **Send Email** | Sends the equity report email with attachment |
| **Log Report Sent** | Records to Report Log tab |
| **Wait 48 Hours** | Delays SMS follow-up |
| **Has Phone Number?** | Routes based on phone availability |
| **Send SMS Follow-up** | Sends Twilio SMS |
| **Log SMS Sent / Log No Phone** | Records SMS status |

## Troubleshooting

### MCP Server Not Responding
- Verify `MCP_SERVER_URL` variable is correct
- Test the URL directly: `curl -X POST https://your-app.vercel.app/mcp`
- Check Vercel deployment logs

### Google Sheets Permission Error
- Re-authenticate Google Sheets credential
- Ensure the sheet is accessible by the authenticated account

### Emails Not Sending
- Verify SMTP credentials
- For Gmail: Use an App Password, not your regular password
- Check spam folder

### SMS Not Sending
- Verify Twilio credentials
- Check phone number format (must include country code: +1...)
- Verify Twilio account has sufficient balance

## Customization

### Change Trigger Schedule
Edit the "Annual Trigger" node:
- `triggerAtMonth`: 1-12 (January = 1)
- `triggerAtDayOfMonth`: 1-31
- `triggerAtHour`: 0-23 (24-hour format)

### Change SMS Delay
Edit the "Wait 48 Hours" node:
- `amount`: Number
- `unit`: `hours`, `days`, `minutes`

### Add More Filters
Edit the "Filter Ready Clients" node to add conditions like:
- Only clients tagged "A+ Client"
- Only clients not contacted in 90 days
- Only properties in specific zip codes

## Manual Steps (Still Required)

These preserve authenticity and aren't automated:

1. **Review comp values** - Update `value_low` and `value_high` in your sheet before running
2. **Record Loom video** - The `loomScript` is generated but you record it
3. **Add Loom link** - Manually add to email or send separately
