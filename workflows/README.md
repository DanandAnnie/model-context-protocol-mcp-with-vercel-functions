# n8n Email Management Workflows

This directory contains n8n workflow configurations for automated email management. These workflows help you organize, categorize, auto-reply, and clean up your emails automatically.

## Quick Start

### Option 1: Docker (Recommended)

```bash
# Start n8n with Docker
docker-compose up -d

# Open n8n in browser
open http://localhost:5678

# Default credentials: admin / changeme
```

### Option 2: Local Installation

```bash
# Install dependencies
pnpm install

# Setup n8n configuration
pnpm run n8n:setup

# Start n8n
pnpm run n8n:start

# In another terminal, import workflows
pnpm run n8n:import
```

### Option 3: Manual Import

1. Start your existing n8n instance
2. Go to **Workflows** → **Import from File**
3. Import the JSON files from this directory

## Workflows Overview

### 1. Email Management Workflow (`email-management.json`)

The main email management workflow that monitors incoming emails and automatically categorizes and processes them.

**Features:**
- **Email Categorization**: Automatically classifies emails as Important, Newsletter, Meeting Request, or General
- **Smart Labeling**: Applies Gmail labels based on email type
- **Notifications**: Sends notifications for important emails via:
  - Email forwarding
  - Slack notifications
- **Calendar Integration**: Creates calendar reminders for meeting requests
- **Activity Logging**: Logs all email processing to Google Sheets

**Flow:**
```
Gmail Trigger → Check Important? → [Important] → Notify + Label → Log
                      ↓
               Check Newsletter? → [Newsletter] → Label + Archive → Log
                      ↓
            Check Meeting Request? → [Meeting] → Create Calendar Event + Label → Log
                      ↓
                   [General] → Label → Log
```

### 2. Email Auto-Reply Workflow (`email-auto-reply.json`)

Automated out-of-office and acknowledgment responses for incoming emails.

**Features:**
- **Smart Filtering**: Skips auto-generated emails (noreply, mailer-daemon, etc.)
- **Duplicate Prevention**: Tracks recent replies to avoid sending multiple responses to the same sender
- **Customizable Messages**: Configurable auto-reply messages via environment variables
- **Activity Logging**: Records all auto-replies sent

**Flow:**
```
Gmail Trigger → Auto-Reply Enabled? → Filter Auto-Emails → Extract Sender
                                              ↓
                              Check Recent Reply? → Send Reply → Log → Label
```

### 3. Email Cleanup Workflow (`email-cleanup.json`)

Scheduled daily cleanup of old and spam emails.

**Features:**
- **Daily Schedule**: Runs automatically every 24 hours
- **Smart Archiving**: Archives read emails older than 30 days (preserves important/starred)
- **Spam Cleanup**: Automatically deletes spam emails
- **Statistics**: Tracks cleanup metrics and generates reports
- **Email Reports**: Sends cleanup summary when significant cleanup occurs

**Flow:**
```
Daily Schedule → Get Old Emails → Filter Non-Important → Archive → Count
                       ↓
               Get Spam → Delete → Count
                       ↓
                   Merge Stats → Log → Send Report (if significant)
```

## Setup Instructions

### Prerequisites

1. **n8n Instance**: Self-hosted n8n or n8n.cloud account
2. **Gmail Account**: With OAuth2 access enabled
3. **Google Sheets**: For logging (optional but recommended)
4. **Slack Workspace**: For notifications (optional)
5. **Google Calendar**: For meeting integration (optional)

### Step 1: Import Workflows

1. Open your n8n instance
2. Go to **Workflows** → **Import from File**
3. Import each workflow JSON file:
   - `email-management.json`
   - `email-auto-reply.json`
   - `email-cleanup.json`

### Step 2: Configure Credentials

Create the following credentials in n8n:

#### Gmail OAuth2
1. Go to **Settings** → **Credentials** → **New**
2. Select **Gmail OAuth2**
3. Follow the OAuth2 setup process
4. Name it: `Gmail Account`

#### Google Sheets OAuth2 (Optional)
1. Create **Google Sheets OAuth2** credential
2. Name it: `Google Sheets Account`

#### Google Calendar OAuth2 (Optional)
1. Create **Google Calendar OAuth2** credential
2. Name it: `Google Calendar Account`

#### Slack API (Optional)
1. Create **Slack API** credential with a bot token
2. Name it: `Slack Account`

### Step 3: Configure Environment Variables

Set these environment variables in n8n:

| Variable | Description | Example |
|----------|-------------|---------|
| `NOTIFICATION_EMAIL` | Email for notifications | `you@example.com` |
| `GOOGLE_SHEET_ID` | Google Sheets document ID | `1abc...xyz` |
| `SLACK_CHANNEL` | Slack channel for notifications | `#email-alerts` |
| `AUTO_REPLY_ENABLED` | Enable/disable auto-reply | `true` or `false` |
| `AUTO_REPLY_MESSAGE` | Custom auto-reply message | `I'm away until Monday...` |
| `SENDER_NAME` | Name to use in auto-replies | `John Doe` |

### Step 4: Create Gmail Labels

Create these labels in Gmail for the workflows to use:
- `Label_Important_Processed`
- `Label_Newsletters`
- `Label_Meeting_Requests`
- `Label_General`
- `Label_Auto_Replied`
- `Label_Archived`

### Step 5: Create Google Sheets (Optional)

Create a Google Sheet with these tabs:
1. **Email Log** - Columns: emailId, from, subject, date, processedAt, labels
2. **Auto-Reply Log** - Columns: senderEmail, senderName, originalSubject, repliedAt, originalEmailId
3. **Cleanup Log** - Columns: archivedCount, deletedSpamCount, processedAt, date

### Step 6: Activate Workflows

1. Open each workflow
2. Click the **Active** toggle to enable
3. Monitor the executions in the n8n dashboard

## Customization

### Modifying Email Categories

Edit the condition nodes in `email-management.json` to change how emails are categorized:
- Update regex patterns in "Check If Newsletter" node
- Modify label checks in "Check If Important" node
- Add new condition branches for custom categories

### Adjusting Cleanup Schedule

In `email-cleanup.json`, modify the Schedule Trigger node:
- Change `hoursInterval` for different frequency
- Use `cronExpression` for specific times

### Custom Auto-Reply Messages

Set the `AUTO_REPLY_MESSAGE` environment variable or edit the message directly in the "Send Auto-Reply" node in `email-auto-reply.json`.

## Troubleshooting

### Common Issues

1. **OAuth Errors**: Refresh your Gmail OAuth2 credentials
2. **Missing Labels**: Create required Gmail labels before running
3. **Rate Limits**: Reduce polling frequency if hitting Gmail API limits
4. **Circular Replies**: Ensure auto-reply workflow filters out your own sent emails

### Logging

All workflows include logging nodes. Check:
- n8n execution history
- Google Sheets logs (if configured)

## Security Considerations

- Store credentials securely in n8n
- Use environment variables for sensitive data
- Regularly review auto-reply logs
- Monitor for unusual email patterns

## Contributing

Feel free to modify these workflows for your specific needs. When sharing modifications:
1. Remove any credentials
2. Replace personal email addresses with placeholders
3. Document any new features
