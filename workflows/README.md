# n8n Automation Workflows

This directory contains n8n workflow configurations for automated email management and HeyGen video generation with smart overlays.

## Table of Contents

- [Email Management Workflows](#email-management-workflows)
- [HeyGen Video Overlay Workflows](#heygen-video-overlay-workflows)
- [Setup Instructions](#setup-instructions)

---

# Email Management Workflows

These workflows help you organize, categorize, auto-reply, and clean up your emails automatically.

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

---

# HeyGen Video Overlay Workflows

These workflows enable HeyGen AI video generation with automatic text and image overlays. Since n8n's built-in image nodes only work with static images (PNG, JPG), these workflows use external video processing services (Cloudinary or Shotstack) to add overlays to videos.

## Available Workflows

### 1. HeyGen Video Generation with Cloudinary Overlays (`heygen-video-generation.json`)

Basic HeyGen video generation with Cloudinary-based video overlays.

**Features:**
- Create HeyGen AI avatar videos via webhook
- Poll for video completion automatically
- Add text overlays at specific timestamps
- Add image/logo watermarks
- Configurable overlay positions and styling

**Webhook Endpoint:** `POST /webhook/heygen-video`

**Request Body:**
```json
{
  "script": "Hello, this is my video script...",
  "avatar_id": "Kristin_pubblic_2_20240108",
  "voice_id": "1bd001e7e50f421d891986aad5158bc8",
  "width": 1920,
  "height": 1080,
  "overlays": [
    {
      "type": "text",
      "text": "Welcome!",
      "position": "south",
      "fontSize": 48,
      "color": "#ffffff",
      "startTime": 0,
      "endTime": 5
    },
    {
      "type": "image",
      "publicId": "my-logo",
      "position": "north_east",
      "width": 150,
      "opacity": 80,
      "startTime": 0,
      "endTime": null
    }
  ]
}
```

### 2. HeyGen Video with Shotstack Overlays (`heygen-shotstack-overlays.json`)

Alternative workflow using Shotstack's professional video editing API.

**Features:**
- Professional video editing effects
- Text overlays with animations
- Lower thirds and titles
- Image and logo overlays
- Transitions and effects

**Webhook Endpoint:** `POST /webhook/heygen-shotstack`

**Request Body:**
```json
{
  "script": "Hello, this is my video script...",
  "overlays": [
    {
      "type": "text",
      "text": "Key Point",
      "style": "minimal",
      "position": "bottom",
      "startTime": 5,
      "endTime": 10
    },
    {
      "type": "lowerThird",
      "text": "Speaker Name\nJob Title",
      "startTime": 2,
      "endTime": 8
    },
    {
      "type": "image",
      "src": "https://example.com/logo.png",
      "position": "topRight",
      "scale": 0.2
    }
  ]
}
```

### 3. Smart Content-Matched Overlays (`heygen-smart-overlays.json`)

**⭐ RECOMMENDED** - Automatically generates overlays based on your script content!

**Features:**
- **AI Content Analysis**: Extracts key points from your script
- **Auto Key Points**: Creates text overlays for numbered points (first, second, etc.)
- **Lower Third Generation**: Auto-generates speaker intro overlays
- **Call-to-Action Detection**: Adds CTA overlays when links/actions are mentioned
- **Logo Watermarking**: Adds your branding automatically
- **Multiple Styles**: minimal, professional, or bold overlay styles
- **Choose Processing Engine**: Cloudinary or Shotstack

**Webhook Endpoint:** `POST /webhook/heygen-smart-video`

**Request Body:**
```json
{
  "script": "Hello, I'm John from Acme Corp. Today I'll share three key insights. First, automation saves time. Second, AI improves quality. Third, integration is seamless. Visit acme.com for more!",
  "speaker_name": "John Smith",
  "speaker_title": "CEO, Acme Corp",
  "branding": {
    "logo_url": "https://example.com/logo.png",
    "primary_color": "#ffffff",
    "secondary_color": "#1a1a1a",
    "font": "Montserrat"
  },
  "overlay_style": "professional",
  "auto_key_points": true,
  "show_lower_third": true,
  "processing_service": "cloudinary"
}
```

**Auto-Generated Overlays:**
Based on the script above, the workflow would automatically create:
1. Logo watermark (top-right, entire video)
2. Speaker lower third (0-6 seconds): "John Smith\nCEO, Acme Corp"
3. Key point 1 overlay (at ~5s): "1. automation saves time"
4. Key point 2 overlay (at ~8s): "2. AI improves quality"
5. Key point 3 overlay (at ~11s): "3. integration is seamless"
6. CTA overlay (last 5 seconds): "👆 Link in description"

## HeyGen Setup Instructions

### Required Environment Variables

Add these to your n8n environment:

| Variable | Description | Required |
|----------|-------------|----------|
| `HEYGEN_API_KEY` | Your HeyGen API key | ✅ Yes |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name | For Cloudinary |
| `CLOUDINARY_API_KEY` | Cloudinary API key | For Cloudinary |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret | For Cloudinary |
| `SHOTSTACK_API_KEY` | Shotstack API key | For Shotstack |
| `SHOTSTACK_STAGE` | `sandbox` or `v1` | For Shotstack |

### Step 1: Configure HeyGen Credentials

1. Get your API key from [HeyGen Dashboard](https://app.heygen.com/settings/api)
2. In n8n, go to **Settings** → **Credentials** → **New**
3. Select **Header Auth**
4. Configure:
   - Name: `HeyGen API Key`
   - Header Name: `X-Api-Key`
   - Header Value: `your-api-key`

### Step 2: Configure Video Processing Service

#### Option A: Cloudinary (Free Tier Available)

1. Sign up at [Cloudinary](https://cloudinary.com/)
2. Get credentials from Dashboard → Settings → Access Keys
3. Create **HTTP Basic Auth** credential in n8n:
   - Name: `Cloudinary API`
   - Username: Your API Key
   - Password: Your API Secret
4. Create an upload preset named `ml_default` in Cloudinary settings

#### Option B: Shotstack (Free Trial Available)

1. Sign up at [Shotstack](https://shotstack.io/)
2. Get your API key from the dashboard
3. Create **Header Auth** credential in n8n:
   - Name: `Shotstack API Key`
   - Header Name: `x-api-key`
   - Header Value: `your-shotstack-key`

### Step 3: Import and Activate

1. Import the desired workflow JSON file
2. Update credential references if needed
3. Activate the workflow
4. Test with a simple request

## Overlay Configuration Reference

### Text Overlay Options

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `type` | string | Must be `"text"` | - |
| `text` | string | The text to display | - |
| `position` | string | `north`, `south`, `east`, `west`, `center`, `north_east`, etc. | `south` |
| `fontSize` | number | Font size in pixels | 48 |
| `color` | string | Text color (hex) | `#ffffff` |
| `fontFamily` | string | Font family name | `Arial` |
| `startTime` | number | Start time in seconds | 0 |
| `endTime` | number | End time in seconds | video end |
| `xOffset` | number | Horizontal offset in pixels | 0 |
| `yOffset` | number | Vertical offset in pixels | 0 |

### Image Overlay Options

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `type` | string | Must be `"image"` | - |
| `src` | string | Image URL | - |
| `publicId` | string | Cloudinary public ID (alternative to src) | - |
| `position` | string | Position on video | `north_east` |
| `width` | number | Width in pixels | 200 |
| `opacity` | number | Opacity (0-100) | 100 |
| `startTime` | number | Start time in seconds | 0 |
| `endTime` | number | End time in seconds | video end |

### Lower Third Options

| Property | Type | Description | Default |
|----------|------|-------------|---------|
| `type` | string | Must be `"lowerThird"` | - |
| `text` | string | Name and title (use `\n` for line break) | - |
| `color` | string | Text color | `#ffffff` |
| `backgroundColor` | string | Background color | `#000000` |
| `startTime` | number | Start time | 2 |
| `endTime` | number | End time | 8 |

## Response Format

All HeyGen workflows return:

```json
{
  "success": true,
  "videoId": "heygen-video-id",
  "originalVideoUrl": "https://...",
  "processedVideoUrl": "https://...",
  "overlaysApplied": 5,
  "processingEngine": "cloudinary"
}
```

## Troubleshooting

### Common Issues

1. **HeyGen Video Stuck in Processing**
   - Videos typically take 1-5 minutes to generate
   - The workflow polls every 10 seconds for up to 10 minutes
   - Check your HeyGen quota/credits

2. **Cloudinary Upload Fails**
   - Ensure `ml_default` upload preset exists and is unsigned
   - Check API credentials are correct
   - Verify cloud name matches your account

3. **Shotstack Render Fails**
   - Verify you're using the correct stage (sandbox vs v1)
   - Check API key is valid
   - Ensure video URL is publicly accessible

4. **Overlays Not Appearing**
   - Check overlay timing (startTime/endTime)
   - Verify position values are valid
   - Ensure text isn't empty

### Debugging Tips

- Enable **Save Manual Executions** in workflow settings
- Check execution logs for API response details
- Test with simple overlays first, then add complexity

---

## Contributing

Feel free to modify these workflows for your specific needs. When sharing modifications:
1. Remove any credentials
2. Replace personal email addresses with placeholders
3. Document any new features
